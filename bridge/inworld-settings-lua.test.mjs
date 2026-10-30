import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {nsuiHarness} from './manager-fixture.mjs';

// The game side of the Inworld cloud voice (docs/INWORLD.md), inside the real manager.lua, manager-ui.lua and nsui.lua over a fake Native Settings UI: the Inworld
// section at the BOTTOM of Settings > Voice and microphone > Custom voices (the API key row, the connection test, one line saying whether the voice can be chosen), its
// command file, the texts it shows and the rules they keep. The conversation service is played by the test: it writes the status file the bridge would.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const remoteSource = readFileSync(new URL('../mod/remote-omni.lua', import.meta.url), 'utf8');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

const fixture = `${nsuiHarness({modules: {'remote-omni.lua': remoteSource}, absent: []})}
  convaiNotices.configure(function() return manager.developerMode() end)
  local clock = 1000
  os.clock = function() return clock end
  os.time = function() return clock end
  -- The bridge's status file (runtime/mistral-state.json) with the Inworld part given; the page is built again from it.
  local function inworldState(tag, inworld)
    jsonFixtures['mistral-' .. tag] = {provider = 'convai', effective = 'convai', saved = false, inworld = inworld}
    files['runtime/mistral-state.json'] = 'mistral-' .. tag
    clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager')
  end
  local function pageIds()
    local list = {}
    for _, category in ipairs(loaded.categories) do
      if category.id == 'custom-voices' then for _, item in ipairs(category.settings) do list[#list + 1] = item.id end end
    end
    return table.concat(list, ',')
  end
  local function first(text) return text:match('^(.-)\\n\\n') or text end
  local function command() return jsonFixtures[files['runtime/inworld-key-command.json']] end
  local function characters(text) local _, count = text:gsub('[^\\128-\\191]', ''); return count end
  assert(invoke('tab:settings').ok and invoke('settings:voice').ok and invoke('custom-voices').ok and managerUi.inspect().view == 'custom-voices')
`;

test('the Inworld section is the last part of the Custom voices page, after Remote OmniVoice: the key row, the connection test and one status line', () => run(`${fixture}
  assert(pageIds() == 'remoteOmni,remote-status,remote-address,remote-test,inworld-key,inworld-test,inworld-voice', pageIds())
  local key, test, status = row('inworld-key'), row('inworld-test'), row('inworld-voice')
  assert(key.type == 'action' and key.label == 'Inworld API key' and key.value == 'Add', key.label .. '|' .. tostring(key.value))
  assert(test.type == 'action' and test.label == 'Test connection' and test.value == 'Test' and test.disabled == true, 'the test needs a saved key')
  assert(status.type == 'string' and status.label == 'Inworld voice' and status.value == 'Add a key to choose it', status.value)
  -- What the help says: your own key, where to get one, and the free plan as it is.
  local help = key.description
  assert(help:find('your own Inworld key', 1, true) and help:find('inworld.ai', 1, true), help)
  assert(help:find('one-time trial of about 70 minutes of speech', 1, true) and help:find('pay as you go', 1, true), help)
  for _, id in ipairs({'inworld-key', 'inworld-test', 'inworld-voice'}) do
    local item = row(id)
    local text = (item.label .. item.description .. tostring(item.value)):lower()
    assert(not text:find('recommend', 1, true), id .. ' is called recommended')
    assert(not text:find('\\226\\128[\\147\\148]') and not text:find('--', 1, true) and not text:find(';', 1, true), id .. ' has a dash or a semicolon')
    assert(characters(item.description) <= 420, id .. ' help is too long for Native Settings UI')
  end
`));

test('Add writes its own command file and nothing else; a failure is the first paragraph of the help; a saved key shows its last four characters with Remove', () => run(`${fixture}
  assert(invoke('inworld-key').ok)
  local pasted = command()
  assert(pasted.version == 1 and pasted.action == 'paste' and pasted.id:find(':ikey:1', 1, true), 'command')
  assert(files['runtime/mistral-key-command.json'] == nil and files['runtime/own-key-command.json'] == nil, 'other key channels')
  assert(row('inworld-key').label == 'Inworld API key (Checking…)' or row('inworld-key').label == 'Inworld API key')
  inworldState('checking', {saved = false, result = {id = pasted.id, state = 'checking'}})
  assert(row('inworld-key').label == 'Inworld API key (Checking…)', row('inworld-key').label)
  inworldState('bad', {saved = false, result = {id = pasted.id, state = 'invalid'}})
  local item = row('inworld-key')
  assert(item.label == 'Inworld API key (Not added)' and item.value == 'Add' and first(item.description) == 'Inworld did not accept that key.', item.label .. ' | ' .. item.description)
  inworldState('unreadable', {saved = false, result = {id = pasted.id, state = 'unreadable'}})
  assert(first(row('inworld-key').description) == 'The clipboard could not be read.')
  inworldState('failed', {saved = false, result = {id = pasted.id, state = 'failed'}})
  assert(first(row('inworld-key').description) == 'The key could not be saved.')
  -- Another command's result is not claimed by this row.
  inworldState('other', {saved = false, result = {id = 'old:ikey:9', state = 'invalid'}})
  assert(row('inworld-key').label == 'Inworld API key' and row('inworld-key').value == 'Add')
  -- Saved: the last four characters, Remove, and the test row is live.
  inworldState('saved', {saved = true, tail = 'wxyz'})
  item = row('inworld-key')
  assert(item.label == 'Inworld API key (…wxyz)' and item.value == 'Remove', item.label)
  assert(item.description:find('Saved on this computer only. Only the last four characters are ever shown.', 1, true))
  assert(row('inworld-test').disabled ~= true)
  inworldState('no-tail', {saved = true})
  assert(row('inworld-key').label == 'Inworld API key (Added)')
  assert(invoke('inworld-key').ok)
  assert(command().action == 'clear' and command().id:find(':ikey:2', 1, true), 'Remove sends a clear command')
`));

test('Test connection sends a test command and shows the answer on its own row; the status line says whether the voice can be chosen', () => run(`${fixture}
  inworldState('saved', {saved = true, tail = 'wxyz'})
  assert(row('inworld-voice').value == 'Ready to choose in Companion voices', row('inworld-voice').value)
  assert(invoke('inworld-test').ok)
  local asked = command()
  assert(asked.action == 'test' and asked.id:find(':ikey:1', 1, true))
  local answers = {checking = 'Checking…', connected = 'Connected', refused = 'Key refused', unreachable = 'Not reachable', ['no-key'] = 'Add a key first'}
  for state, shown in pairs(answers) do
    inworldState('t-' .. state, {saved = true, tail = 'wxyz', result = {id = asked.id, state = state}})
    assert(row('inworld-test').value == shown, state .. ': ' .. tostring(row('inworld-test').value))
  end
  inworldState('later', {saved = true, tail = 'wxyz', result = {id = 'older:ikey:1', state = 'connected'}})
  assert(row('inworld-test').value == 'Test', 'a result of another command is not shown')
  -- The voice chosen: the status line says so (saved settings, nothing is asked of Inworld to draw it).
  assert(manager.applySettings(player, {voiceProvider = 'inworld'}))
  loaded = registered.loadMod('manager')
  assert(row('inworld-voice').value == 'Chosen as the Companion voice', row('inworld-voice').value)
  -- Beside Mature content it is not used.
  assert(manager.applySettings(player, {conversationProvider = 'local', matureContent = true}))
  loaded = registered.loadMod('manager')
  assert(row('inworld-voice').value == 'Not used with Mature content', row('inworld-voice').value)
`));

test('the page is built from the saved settings and the status file alone: a key change redraws it, and opening it sends no command', () => run(`${fixture}
  assert(files['runtime/inworld-key-command.json'] == nil, 'opening the page sent a command')
  local before = managerUi.signature and managerUi.signature() or nil
  inworldState('saved', {saved = true, tail = 'wxyz'})
  assert(row('inworld-key').value == 'Remove')
  inworldState('gone', {saved = false})
  assert(row('inworld-key').value == 'Add' and row('inworld-test').disabled == true)
  assert(files['runtime/inworld-key-command.json'] == nil, 'reading the status sent a command')
`));

test('turning Mature content on from the Settings page moves an Inworld voice to Pocket and records the way back, and turning it off puts it back while the key is saved', () => run(`${fixture}
  assert(invoke('custom-voices:back').ok and managerUi.inspect().view == 'settings-voice', 'Back returns to Voice and microphone')
  local function withKey(tag, keySaved)
    jsonFixtures['mistral-' .. tag] = {provider = 'convai', effective = 'convai', saved = false, localAi = 'ready', inworld = {saved = keySaved, tail = keySaved and 'wxyz' or nil}}
    files['runtime/mistral-state.json'] = 'mistral-' .. tag
    clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager')
  end
  withKey('on', true)
  assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 9}}).ok and saved.voiceProvider == 'inworld')
  loaded = registered.loadMod('manager')
  local result = registered.applyBatch('manager', {{id = 'matureContent', value = true}})
  assert(result.ok, tostring(result.error))
  assert(saved.matureContent == true and saved.voiceProvider == 'pocket', 'the voice moved to Pocket: ' .. tostring(saved.voiceProvider))
  assert(saved.matureRestore and saved.matureRestore.voice and saved.matureRestore.voice.before.provider == 'inworld', 'the way back is kept')
  loaded = registered.loadMod('manager')
  result = registered.applyBatch('manager', {{id = 'matureContent', value = false}})
  assert(result.ok and saved.matureContent == false and saved.voiceProvider == 'inworld', 'the voice came back: ' .. tostring(saved.voiceProvider))
  -- With the key gone it does not come back (it could not be chosen).
  loaded = registered.loadMod('manager')
  assert(registered.applyBatch('manager', {{id = 'matureContent', value = true}}).ok and saved.voiceProvider == 'pocket')
  withKey('gone', false)
  assert(registered.applyBatch('manager', {{id = 'matureContent', value = false}}).ok and saved.voiceProvider == 'pocket', 'no key: it stays on Pocket')
`));
