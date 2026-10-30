import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {nsuiHarness} from './manager-fixture.mjs';

// The game side of Remote OmniVoice (docs/REMOTE_OMNIVOICE.md): mod/remote-omni.lua on its own (state cleaning, the two rows, the commands, the test sentences) and
// inside the real manager.lua, manager-ui.lua and nsui.lua over a fake Native Settings UI (the Custom voices button on the Voices page, the page with its switch, status,
// address and test, the saved setting, the pack rule and the notice). The conversation service is played by the test: it writes the state files the bridge would.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');
const remoteSource = read('remote-omni.lua');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

const moduleFixture = `
  local ui = convaiUiLocale
  local factory = (function() ${remoteSource} end)()
  local clock, written, failWrite, shown = 1000, {}, false, nil
  local function make(extra)
    local options = {ui = ui, clock = function() return clock end,
      readJSON = function(path) assert(path == 'runtime/remote-omni-state.json', path); return shown end,
      writeCommand = function(path, value)
        assert(path == 'runtime/remote-omni-command.json', path)
        if failWrite then return false end
        written[#written + 1] = value; return true
      end,
      session = function() return 'sess-1' end}
    for key, value in pairs(extra or {}) do options[key] = value end
    return factory.new(options)
  end
  local function publish(value) shown = value; clock = clock + 2 end
  local function rowsOf(provider) local list = {}; for _, item in ipairs(provider.rows()) do list[item.id] = item end; return list end
  local function first(text) return text:match('^(.-)\\n\\n') or text end
`;

test('nothing published: an address to paste, a Test row that waits for the service, and nothing is invented', () => run(`${moduleFixture}
  local provider = make()
  local state = provider.state()
  assert(state.available == false and state.set == false and state.address == nil and state.result == nil and state.test == nil)
  local rows = rowsOf(provider)
  assert(rows['remote-address'].label == 'Server address' and rows['remote-address'].value == 'Paste address' and rows['remote-address'].action == 'paste-address')
  assert(rows['remote-test'].enabled == false and first(rows['remote-test'].help) == 'The conversation service is not running, so nothing can be tested. Restart the game.')
  local ids = {}
  for _, item in ipairs(provider.rows()) do ids[#ids + 1] = item.id end
  assert(table.concat(ids, ',') == 'remote-address,remote-test')
`));

test('a saved address shows with Remove; garbage in the state file never raises and never invents a value', () => run(`${moduleFixture}
  local provider = make()
  publish({version = 1, set = true, address = '192.168.1.20:8765'})
  local rows = rowsOf(provider)
  assert(rows['remote-address'].label == 'Server address (192.168.1.20:8765)' and rows['remote-address'].value == 'Remove' and rows['remote-address'].action == 'clear-address')
  assert(rows['remote-test'].enabled == true)
  for _, junk in ipairs({'text', 5, true, {}, {version = 'x'}, {version = 1, address = 5}, {version = 1, address = ('x'):rep(300)},
      {version = 1, address = 'bad address'}, {version = 1, test = 'no'}, {version = 1, result = {id = 1}}}) do
    publish(junk)
    local ok, state = pcall(provider.state)
    assert(ok, 'state raised')
    assert(state.address == nil and state.test == nil and state.result == nil)
    assert(pcall(provider.rows) and pcall(provider.signature))
  end
`));

test('commands: the three actions, one file, ids of this session; a failed write says so; only the latest answer counts', () => run(`${moduleFixture}
  local provider = make()
  publish({version = 1})
  assert(provider.request('paste-address') == true)
  local sent = written[#written]
  assert(sent.version == 1 and sent.action == 'paste-address' and type(sent.issuedAt) == 'number' and sent.id:match('^sess%-1:remote:%d+$'), sent.id)
  -- a refusal for this command is shown in the address row, first
  publish({version = 1, result = {id = sent.id, state = 'invalid', reason = 'scheme'}})
  local row = rowsOf(provider)['remote-address']
  assert(first(row.help) == 'Use the address the server window shows, such as 192.168.1.20:8765, without https://.', row.help)
  assert(row.label == 'Server address (Not added)')
  for reason, sentence in pairs({empty = 'The clipboard is empty. Copy the address first.', extras = 'Use the address only: no user name, no path, no #.',
      host = 'The clipboard does not hold a server address.', port = 'The port must be a number from 1 to 65535.', long = 'That is too long.'}) do
    publish({version = 1, result = {id = sent.id, state = 'invalid', reason = reason}})
    assert(first(rowsOf(provider)['remote-address'].help) == sentence, reason)
  end
  -- an answer for an older command is not shown
  assert(provider.request('paste-address')); local again = written[#written]
  assert(again.id ~= sent.id)
  publish({version = 1, result = {id = sent.id, state = 'invalid', reason = 'host'}})
  assert(rowsOf(provider)['remote-address'].label == 'Server address')
  assert(provider.request('unknown') == false)
  assert(provider.request('clear-address') == true and written[#written].action == 'clear-address')
  failWrite = true
  local ok, message = provider.request('test')
  assert(ok == false and message == 'The request could not be sent. Try again.')
`));

test('the Test row: testing, ready with its numbers, loading, and a plain sentence for every failure', () => run(`${moduleFixture}
  local provider = make()
  publish({version = 1, set = true, address = 'gaming-pc.local:8765'})
  assert(provider.request('test')); local id = written[#written].id
  publish({version = 1, set = true, address = 'gaming-pc.local:8765', test = {id = id, state = 'testing'}})
  local row = rowsOf(provider)['remote-test']
  assert(row.label == 'Test connection (Testing…)' and row.enabled == false)
  publish({version = 1, address = 'gaming-pc.local:8765', test = {id = id, state = 'ok', ms = 4, version = '0.3.3', device = 'cuda:0'}})
  row = rowsOf(provider)['remote-test']
  assert(row.label == 'Test connection (OK)' and row.enabled == true)
  assert(first(row.help) == 'The server is ready. It answers in 4 ms. Its voice runs on cuda:0. Version 0.3.3.', first(row.help))
  publish({version = 1, address = 'x', test = {id = id, state = 'loading', ms = 7}})
  row = rowsOf(provider)['remote-test']
  assert(row.label == 'Test connection (Loading)' and first(row.help) == 'The server answered but is still loading its voice. Try again in a minute. It answers in 7 ms.')
  local words = {
    ['no-address'] = 'Add a server address first.',
    unreachable = 'Nothing answered at that address.',
    timeout = 'The server took too long to answer.',
    ['not-omnivoice'] = 'Something answered, but it is not the OmniVoice server. Check the port.',
    protocol = 'The server is another version.',
    blocked = 'The server refused the request.',
    server = 'The server answered but could not load its voice.'}
  for code, start in pairs(words) do
    publish({version = 1, address = 'x', test = {id = id, state = 'failed', code = code}})
    row = rowsOf(provider)['remote-test']
    assert(row.label == 'Test connection (Failed)' and first(row.help):sub(1, #start) == start, code .. ': ' .. first(row.help))
  end
  publish({version = 1, address = 'x', test = {id = id, state = 'failed', code = 'made-up'}})
  assert(first(rowsOf(provider)['remote-test'].help) == 'The connection test failed.')
  -- another test's id, or one the service never finished, is not claimed
  publish({version = 1, address = 'x', test = {id = 'old:remote:1', state = 'ok', ms = 1}})
  assert(rowsOf(provider)['remote-test'].label == 'Test connection')
  publish({version = 1, address = 'x', test = {id = id, state = 'testing'}})
  clock = clock + 100
  assert(rowsOf(provider)['remote-test'].label == 'Test connection')
`));

test('the state file is read at most every 1.5 s, at once after a command; the signature follows what a row shows', () => run(`${moduleFixture}
  local reads = 0
  local provider = make({readJSON = function() reads = reads + 1; return shown end})
  publish({version = 1}); provider.state(); provider.state(); provider.state()
  assert(reads == 1)
  clock = clock + 2; provider.state(); assert(reads == 2)
  local before = provider.signature()
  publish({version = 1, set = true, address = 'a.b:1'})
  assert(provider.signature() ~= before)
  provider.request('test'); provider.state(); assert(reads >= 3)
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// Inside the real manager.lua, manager-ui.lua and nsui.lua
// ---------------------------------------------------------------------------------------------------------------------------------

const pageFixture = (withModule = true, source = remoteSource) => nsuiHarness({
  modules: withModule ? {'remote-omni.lua': source} : {},
  absent: withModule ? [] : ['remote-omni.lua'],
}) + `
  convaiNotices.configure(function() return manager.developerMode() end)
`;

const stateFixture = `
  local clock = 1000
  os.clock = function() return clock end
  os.time = function() return clock end
  local function file(path, tag, value) jsonFixtures[tag] = value; files[path] = tag end
  local function service(tag, value) file('runtime/remote-omni-state.json', 'remote-' .. tag, value); clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager') end
  local function voiceState(tag, value) value.updated = clock * 1000.0; file('runtime/local-voice-state.json', 'voice-' .. tag, value); clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager') end
  local function command() return jsonFixtures[files['runtime/remote-omni-command.json']] end
  local function voiceIds()
    local order = {}
    for _, category in ipairs(loaded.categories) do
      if category.id == 'voices' then for _, item in ipairs(category.settings) do order[#order + 1] = item.id end end
    end
    return table.concat(order, ',')
  end
`;

test('a Custom voices button sits right under the voice list; the page has the switch, the status, the address and the test, and a way back', () => run(`${pageFixture()}${stateFixture}
  assert(invoke('tab:settings').ok)
  local ids = voiceIds()
  assert(ids:find('voiceProvider,custom%-voices,replyLanguage', 1), ids)
  assert(row('custom-voices').type == 'action' and row('custom-voices').value == 'Open' and row('custom-voices').label == 'Custom voices')
  assert(invoke('custom-voices').ok and managerUi.inspect().view == 'custom-voices')
  assert(loaded.categories[1].settings[1].id == 'custom-voices:back' and loaded.categories[1].settings[1].label == 'Back to settings')
  local pageIds = {}
  for _, category in ipairs(loaded.categories) do
    if category.id == 'custom-voices' then for _, item in ipairs(category.settings) do pageIds[#pageIds + 1] = item.id end end
  end
  assert(table.concat(pageIds, ',') == 'remoteOmni,remote-status,remote-address,remote-test,inworld-key,inworld-test,inworld-voice', table.concat(pageIds, ','))
  assert(row('remoteOmni').type == 'bool' and row('remoteOmni').value == false and row('remoteOmni').label == 'Remote OmniVoice')
  assert(row('remote-status').value == 'Off. OmniVoice runs on this PC.')
  assert(row('remote-address').type == 'action' and row('remote-test').type == 'action' and row('remote-test').disabled == true)
  for _, id in ipairs({'remoteOmni', 'remote-status', 'remote-address', 'remote-test'}) do
    assert(not (row(id).description .. row(id).label):lower():find('recommend', 1, true), id)
  end
  assert(invoke('custom-voices:back').ok and managerUi.inspect().view == 'settings' and row('custom-voices') and not row('remote-address'))
`));

test('without the module (or with one that fails) the Voices page is unchanged and the page is not offered', () => {
  run(`${pageFixture(false)}${stateFixture}
    assert(invoke('tab:settings').ok)
    assert(row('custom-voices') == nil and not invoke('custom-voices').ok)
    assert(not voiceIds():find('custom', 1, true), voiceIds())
    assert(voiceIds():find('voiceProvider,replyLanguage', 1, true), voiceIds())
  `);
  const raising = remoteSource.replace('function self.rows()', 'function self.rows() error("boom") end\n    function self.unusedRows()');
  run(`${pageFixture(true, raising)}${stateFixture}
    assert(invoke('tab:settings').ok and invoke('custom-voices').ok)
    assert(row('remoteOmni') and row('remote-status') and row('remote-address') == nil and row('remote-test') == nil, 'the switch and status stay, the rows are left out')
  `);
  const broken = remoteSource.replace('function M.new(options)', 'function M.new(options) error("no instance")');
  run(`${pageFixture(true, broken)}${stateFixture}
    assert(invoke('tab:settings').ok and row('custom-voices') == nil)
  `);
});

test('the switch is a saved setting: off by default, applied with the rest, survives a reload, and only a boolean is accepted', () => run(`${pageFixture()}${stateFixture}
  assert(manager.snapshot(player).settings.remoteOmni == false)
  assert(invoke('tab:settings').ok and invoke('custom-voices').ok)
  assert(registered.applyBatch('manager', {{id = 'remoteOmni', value = true}}).ok)
  assert(manager.snapshot(player).settings.remoteOmni == true and saved.remoteOmni == true)
  loaded = registered.loadMod('manager')
  assert(row('remoteOmni').value == true)
  assert(not registered.applyBatch('manager', {{id = 'remoteOmni', value = 'yes'}}).ok)
  assert(manager.snapshot(player).settings.remoteOmni == true, 'a refused value changes nothing')
  assert(registered.applyBatch('manager', {{id = 'remoteOmni', value = false}}).ok and saved.remoteOmni == false)
`));

test('the status line follows the setting, the saved address and the voice service\'s own report', () => run(`${pageFixture()}${stateFixture}
  assert(invoke('tab:settings').ok and invoke('custom-voices').ok)
  assert(registered.applyBatch('manager', {{id = 'remoteOmni', value = true}}).ok); loaded = registered.loadMod('manager')
  -- Pocket is the saved voice: it keeps speaking until an address is saved, and the status says so.
  assert(row('remote-status').value == 'On, but no server address is saved. Pocket is used until you add one.', row('remote-status').value)
  service('a', {version = 1, set = true, address = '192.168.1.20:8765'})
  -- Not heard from the voice service yet: waiting, never a wrong claim about the voice.
  assert(row('remote-status').value == 'On. Waiting for the conversation service.', row('remote-status').value)
  -- The server is used with Pocket saved too (the service asks for OmniVoice then): the status names the voice it speaks with.
  voiceState('b', {provider = 'text', requestedProvider = 'omni', omniRemote = {set = true, connected = false}})
  assert(row('remote-status').value == 'Not connected. Replies show as text until the server answers.', row('remote-status').value)
  voiceState('c', {provider = 'omni', requestedProvider = 'omni', omniRemote = {set = true, connected = true}})
  assert(row('remote-status').value == 'Connected. The server speaks with OmniVoice · Quality.', row('remote-status').value)
  -- OmniVoice saved and no address: the old sentence.
  service('none', {version = 1, set = false})
  voiceState('e', {provider = 'text', requestedProvider = 'omni', omniRemote = {set = false, connected = false}})
  assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 7}}).ok); loaded = registered.loadMod('manager')
  assert(row('remote-status').value == 'On, but no server address is saved. OmniVoice cannot speak yet.', row('remote-status').value)
  service('a2', {version = 1, set = true, address = '192.168.1.20:8765'})
  voiceState('d', {provider = 'omni', requestedProvider = 'omni', omniRemote = {set = true, connected = true}})
  assert(row('remote-status').value == 'Connected. The server speaks with OmniVoice · Ultra Quality.', row('remote-status').value)
  assert(row('remote-address').label == 'Server address (192.168.1.20:8765)' and row('remote-address').value == 'Remove')
`));

test('the rows send their commands on their own channel, in place; the page follows the service', () => run(`${pageFixture()}${stateFixture}
  files['runtime/remote-omni-command.json'] = ''
  assert(invoke('tab:settings').ok and invoke('custom-voices').ok)
  local removed = {}
  local remove = os.remove
  os.remove = function(path) removed[#removed + 1] = path; return remove(path) end
  assert(invoke('remote-address').ok)
  local sent = command()
  assert(sent.version == 1 and sent.action == 'paste-address' and sent.id:find(':remote:', 1, true) and #sent.id <= 160, sent.id)
  service('saved', {version = 1, set = true, address = 'gaming-pc.local:8765', result = {id = sent.id, state = 'saved'}})
  assert(row('remote-address').value == 'Remove' and row('remote-test').disabled == false)
  assert(invoke('remote-test').ok and command().action == 'test'); local id = command().id
  service('testing', {version = 1, set = true, address = 'gaming-pc.local:8765', test = {id = id, state = 'testing'}})
  assert(row('remote-test').label == 'Test connection (Testing…)' and row('remote-test').disabled == true)
  service('ok', {version = 1, set = true, address = 'gaming-pc.local:8765', test = {id = id, state = 'ok', ms = 3, version = '0.3.3', device = 'cuda:1'}})
  assert(row('remote-test').label == 'Test connection (OK)' and row('remote-test').description:find('It answers in 3 ms.', 1, true))
  assert(files['runtime/custom-provider-command.json'] == nil and files['runtime/memory-command.json'] == nil, 'another channel was used')
  assert(#removed == 0, 'a command file was removed')
  failSave = true
  local result = invoke('remote-address')
  assert(result.ok == false and result.error == 'The request could not be sent. Try again.', tostring(result.error))
`));

test('OmniVoice can be chosen without the pack while Remote OmniVoice is on (saved or in the same save), and not otherwise', () => run(`${pageFixture()}${stateFixture}
  voiceState('nopack', {provider = 'pocket', requestedProvider = 'pocket', omniPack = {installed = false, missing = {'python'}}})
  assert(manager.omniPack().installed == false)
  local refused = registered.applyBatch('manager', {{id = 'voiceProvider', value = 4}})
  assert(refused.ok == false, 'OmniVoice needs the pack when remote is off')
  assert(manager.snapshot(player).settings.voiceProvider == 'pocket')
  -- on in the same save: no pack needed
  local both = registered.applyBatch('manager', {{id = 'remoteOmni', value = true}, {id = 'voiceProvider', value = 4}})
  assert(both.ok, tostring(both.error))
  assert(manager.snapshot(player).settings.remoteOmni == true and manager.snapshot(player).settings.voiceProvider == 'omni')
  -- the bridge says the pack is not needed now (remote): the entry is choosable in a later save as well
  assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 2}}).ok)
  assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 4}}).ok, 'saved remote counts')
`));

test('the failed-server notice is its own sentence, once', () => run(`${pageFixture()}${stateFixture}
  voiceState('a', {provider = 'omni', requestedProvider = 'omni', state = 'ready'})
  voiceState('b', {provider = 'text', requestedProvider = 'omni', requestedOmniSteps = 16, requestedOmniReference = 'long',
    fallback = {from = 'omni', to = 'text', reason = 'omni-remote', temporary = true}})
  local notice = manager.takeVoiceFallbackNotice()
  assert(notice == 'The OmniVoice server cannot be reached. Replies show as text until it answers. The mod asks it again every few seconds.', tostring(notice))
  assert(manager.takeVoiceFallbackNotice() == nil)
`));

test('release plumbing: the module ships with the scripts, the catalogue reads it', () => {
  const plan = JSON.parse(readFileSync(new URL('../packaging/release-plan.json', import.meta.url), 'utf8'));
  const development = JSON.parse(readFileSync(new URL('../scripts/development-files.json', import.meta.url), 'utf8'));
  assert.ok(JSON.stringify(plan).includes('"mod/remote-omni.lua"'));
  assert.ok(JSON.stringify(development).includes('"mod/remote-omni.lua"'));
  assert.ok(readFileSync(new URL('../scripts/Extract-UiCatalog.mjs', import.meta.url), 'utf8').includes("'mod/remote-omni.lua'"));
});
