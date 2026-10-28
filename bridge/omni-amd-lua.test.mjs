import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {nsuiHarness} from './manager-fixture.mjs';

// The game side of OmniVoice for AMD (docs/OMNIVOICE_AMD.md): mod/omni-amd.lua on its own (state cleaning, the setup and remove rows, the commands, the sentences) and
// inside the real manager.lua, manager-ui.lua and nsui.lua over a fake Native Settings UI (the Voices row, the page with its rows and the MIOpen choice, the saved setting).
// The conversation service is played by the test: it writes the state file the bridge would.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');
const amdSource = read('omni-amd.lua');

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
  local factory = (function() ${amdSource} end)()
  local clock, written, failWrite, shown = 1000, {}, false, nil
  local function make(extra)
    local options = {ui = ui, clock = function() return clock end,
      readJSON = function(path) assert(path == 'runtime/omni-amd-state.json', path); return shown end,
      writeCommand = function(path, value)
        assert(path == 'runtime/omni-amd-command.json', path)
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
  local offered = {version = 1, offered = true, installed = false, arch = 'gfx1201', card = 'AMD Radeon RX 9070 XT', downloadMiB = 1480, diskMiB = 4100}
  local function with(extra) local copy = {}; for k, v in pairs(offered) do copy[k] = v end; for k, v in pairs(extra) do copy[k] = v end; return copy end
`;

test('nothing published: the setup row waits for the service, is greyed, and nothing is invented', () => run(`${moduleFixture}
  local provider = make()
  local state = provider.state()
  assert(state.available == false and state.offered == false and state.installed == false and state.job == nil and state.test == nil and provider.visible() == false)
  local rows = provider.rows()
  assert(#rows == 1 and rows[1].id == 'omni-amd-setup' and rows[1].label == 'Set up OmniVoice for AMD' and rows[1].enabled == false)
  assert(first(rows[1].help) == 'The conversation service is not running. Restart the game.')
`));

test('offered and not installed: Install with the size, the disk space and the explanation; no Remove row', () => run(`${moduleFixture}
  local provider = make()
  publish(with({}))
  assert(provider.visible() == true)
  local rows = rowsOf(provider)
  local setup = rows['omni-amd-setup']
  assert(setup.label == 'Set up OmniVoice for AMD' and setup.value == 'Install' and setup.action == 'install' and setup.enabled == true)
  assert(rows['omni-amd-remove'] == nil)
  assert(setup.help:find('One download from AMD of about 1.4 GB.', 1, true), setup.help)
  assert(setup.help:find('It takes about 4.0 GB on drive C: in the mod’s data folder.', 1, true), setup.help)
  assert(setup.help:find('It runs in the background while you play. The game keeps running and nothing else changes.', 1, true))
  assert(setup.help:find('Experimental. Pocket speaks until it is ready. A local voice never switches to a cloud voice.', 1, true))
  assert(not setup.help:find(';', 1, true))
  -- no sizes known: the sentences still read well
  publish(with({downloadMiB = false, diskMiB = false}))
  setup = rowsOf(provider)['omni-amd-setup']
  assert(setup.help:find('One download from AMD.', 1, true) and setup.help:find('kept in the mod’s data folder on drive C:', 1, true), setup.help)
  -- a PC that is not offered it
  publish({version = 1, offered = false, installed = false})
  setup = rowsOf(provider)['omni-amd-setup']
  assert(provider.visible() == false and setup.enabled == false and first(setup.help) == 'Not available on this PC. It needs an AMD Radeon card and the OmniVoice pack.')
`));

test('a running job: progress, unpacking and testing, with Cancel; and it is shown even for a command this page did not send', () => run(`${moduleFixture}
  local provider = make()
  -- the page was opened mid-download: nothing was sent from here
  publish(with({job = {id = 'old-session:amd:7', action = 'install', state = 'downloading', doneMiB = 370, totalMiB = 1480}}))
  assert(provider.lastCommand() == nil)
  local row = rowsOf(provider)['omni-amd-setup']
  assert(first(row.help) == 'Downloading 370 of 1480 MB (25%)', first(row.help))
  assert(row.label == 'Set up OmniVoice for AMD (25%)' and row.value == 'Cancel' and row.action == 'cancel' and row.enabled == true)
  publish(with({job = {id = 'old-session:amd:7', action = 'install', state = 'checking'}}))
  row = rowsOf(provider)['omni-amd-setup']
  assert(first(row.help) == 'Checking your card…' and row.value == 'Cancel')
  publish(with({job = {id = 'old-session:amd:7', action = 'install', state = 'downloading', doneMiB = 5, totalMiB = 0}}))
  assert(first(rowsOf(provider)['omni-amd-setup'].help) == 'Downloading…')
  publish(with({job = {id = 'old-session:amd:7', action = 'install', state = 'downloading', doneMiB = 9000, totalMiB = 1480}}))
  assert(first(rowsOf(provider)['omni-amd-setup'].help) == 'Downloading 1480 of 1480 MB (100%)', 'done is never above total')
  publish(with({job = {id = 'old-session:amd:7', action = 'install', state = 'unpacking'}}))
  row = rowsOf(provider)['omni-amd-setup']
  assert(first(row.help) == 'Unpacking…' and row.value == 'Cancel')
  publish(with({job = {id = 'old-session:amd:7', action = 'install', state = 'testing'}}))
  row = rowsOf(provider)['omni-amd-setup']
  assert(first(row.help) == 'Testing it on your card…' and row.value == 'Cancel')
  -- no Remove while a job runs, even with a setup on disk
  publish(with({installed = true, job = {id = 'x:amd:1', action = 'install', state = 'downloading', doneMiB = 1, totalMiB = 2}}))
  assert(rowsOf(provider)['omni-amd-remove'] == nil)
`));

test('the latest-command rule: a finished job counts only for the command this page sent last', () => run(`${moduleFixture}
  local provider = make()
  publish(with({}))
  assert(provider.request('install') == true); local sent = written[#written]
  -- a finished job of another command is not shown
  publish(with({installed = true, job = {id = 'other:amd:1', action = 'install', state = 'done'}}))
  assert(provider.state().job == nil)
  assert(rowsOf(provider)['omni-amd-setup'].label == 'Set up OmniVoice for AMD (Installed)')
  -- the answer to this command is
  publish(with({installed = true, test = {state = 'used', backend = 'rocm', device = 'AMD Radeon RX 9070 XT', vramMiB = 16304},
    job = {id = sent.id, action = 'install', state = 'done'}}))
  local row = rowsOf(provider)['omni-amd-setup']
  assert(first(row.help) == 'Ready. OmniVoice runs on AMD Radeon RX 9070 XT with AMD’s ROCm.', first(row.help))
  assert(row.label == 'Set up OmniVoice for AMD (Ready)' and row.value == 'Reinstall' and row.action == 'install')
  -- a newer command makes the older answer stale
  assert(provider.request('install')); local again = written[#written]
  assert(again.id ~= sent.id)
  publish(with({installed = true, job = {id = sent.id, action = 'install', state = 'done'}}))
  assert(provider.state().job == nil)
  -- a running job is shown whatever its id
  publish(with({installed = true, job = {id = sent.id, action = 'install', state = 'unpacking'}}))
  assert(provider.state().job.state == 'unpacking')
  -- cancelled and removed
  publish(with({job = {id = again.id, action = 'install', state = 'cancelled'}}))
  row = rowsOf(provider)['omni-amd-setup']
  assert(first(row.help) == 'Cancelled.' and row.value == 'Install')
  assert(provider.request('remove')); local removal = written[#written]
  publish(with({job = {id = removal.id, action = 'remove', state = 'removed'}}))
  row = rowsOf(provider)['omni-amd-setup']
  assert(first(row.help) == 'The AMD setup was removed.' and row.value == 'Install')
`));

test('every failure code has its own plain sentence; a failure offers Reinstall; an unknown code still reads', () => run(`${moduleFixture}
  local provider = make()
  publish(with({})); assert(provider.request('install')); local id = written[#written].id
  local words = {
    ['no-pack'] = 'The OmniVoice pack is not installed.',
    ['not-amd'] = 'This PC has no AMD Radeon card',
    ['unsupported-card'] = 'AMD’s ROCm PyTorch does not support this card yet.',
    ['no-space'] = 'There is not enough free space on drive C:.',
    ['download-failed'] = 'The download did not finish.',
    checksum = 'The downloaded files did not check out.',
    ['unpack-failed'] = 'The files could not be unpacked.',
    ['test-failed'] = 'The setup did not pass the test on your card',
    busy = 'Another setup is already running.',
    ['not-ready'] = 'The download is not ready yet in this version of the mod.',
    cancelled = 'Cancelled.'}
  local seen = {}
  for code, start in pairs(words) do
    publish(with({job = {id = id, action = 'install', state = 'failed', code = code}}))
    local row = rowsOf(provider)['omni-amd-setup']
    assert(first(row.help):sub(1, #start) == start, code .. ': ' .. first(row.help))
    assert(row.value == 'Reinstall' and row.action == 'install' and row.enabled == true and row.label == 'Set up OmniVoice for AMD (Failed)', code)
    assert(not seen[first(row.help)], 'two codes share a sentence: ' .. code)
    seen[first(row.help)] = true
  end
  publish(with({job = {id = id, action = 'install', state = 'failed', code = 'made-up'}}))
  assert(first(rowsOf(provider)['omni-amd-setup'].help) == 'The setup did not finish. Try again.')
  publish(with({job = {id = id, action = 'install', state = 'failed'}}))
  assert(first(rowsOf(provider)['omni-amd-setup'].help) == 'The setup did not finish. Try again.')
`));

test('installed: the test result decides the words, Remove appears with the freed space; the own Python wins and greys the setup', () => run(`${moduleFixture}
  local provider = make()
  publish(with({installed = true}))
  local rows = rowsOf(provider)
  assert(first(rows['omni-amd-setup'].help) == 'Installed. OmniVoice uses it when it starts.' and rows['omni-amd-setup'].value == 'Reinstall')
  assert(rows['omni-amd-remove'].label == 'Remove AMD setup' and rows['omni-amd-remove'].value == 'Remove' and rows['omni-amd-remove'].action == 'remove' and rows['omni-amd-remove'].enabled)
  assert(rows['omni-amd-remove'].help == 'Frees about 4.0 GB. OmniVoice then no longer starts on this card until it is set up again.', rows['omni-amd-remove'].help)
  local ids = {}
  for _, item in ipairs(provider.rows()) do ids[#ids + 1] = item.id end
  assert(table.concat(ids, ',') == 'omni-amd-setup,omni-amd-remove')
  publish(with({installed = true, test = {state = 'used', backend = 'rocm', device = 'AMD Radeon RX 9070 XT', vramMiB = 16304}}))
  assert(first(rowsOf(provider)['omni-amd-setup'].help) == 'Ready. OmniVoice runs on AMD Radeon RX 9070 XT with AMD’s ROCm.')
  publish(with({installed = true, test = {state = 'refused', backend = 'none', reason = 'no-gpu'}}))
  local row = rowsOf(provider)['omni-amd-setup']
  assert(first(row.help) == 'The setup is installed but did not pass the test on your card. Choose Reinstall.' and row.label == 'Set up OmniVoice for AMD (Failed)')
  publish(with({installed = true, test = {state = 'testing'}}))
  assert(first(rowsOf(provider)['omni-amd-setup'].help) == 'Testing it on your card…')
  -- a card name that is missing reads as plain words
  publish(with({installed = true, card = false, test = {state = 'used', backend = 'rocm'}}))
  assert(first(rowsOf(provider)['omni-amd-setup'].help) == 'Ready. OmniVoice runs on your AMD card with AMD’s ROCm.')
  -- the player's own Python wins
  publish(with({ownPython = true}))
  row = rowsOf(provider)['omni-amd-setup']
  assert(row.enabled == false and row.label == 'Set up OmniVoice for AMD (Own Python)')
  assert(first(row.help) == 'Your own Python (omni-python.txt) is used instead. Delete that file to use this setup.', first(row.help))
  -- with a setup on disk, Remove stays available
  publish(with({ownPython = true, installed = true}))
  assert(rowsOf(provider)['omni-amd-remove'] ~= nil and rowsOf(provider)['omni-amd-setup'].enabled == false)
`));

test('garbage in the state file never raises and never invents a value', () => run(`${moduleFixture}
  local provider = make()
  for _, junk in ipairs({'text', 5, true, {}, {version = 'x'}, {version = 1, card = 5}, {version = 1, card = ('x'):rep(100)}, {version = 1, card = 'bad\\1card'},
      {version = 1, job = 'no'}, {version = 1, job = {id = 1}}, {version = 1, job = {id = 'a', action = 'explode', state = 'downloading'}},
      {version = 1, job = {id = 'a', action = 'install', state = 'dancing'}}, {version = 1, test = 'no'}, {version = 1, test = {state = 'maybe'}},
      {version = 1, downloadMiB = -5, diskMiB = 'many'}, {version = 1, offered = 'yes', installed = 1}}) do
    publish(junk)
    local ok, state = pcall(provider.state)
    assert(ok, 'state raised')
    assert(state.job == nil and state.test == nil and state.card == nil and state.downloadMiB == nil and state.diskMiB == nil and state.offered == false and state.installed == false)
    assert(pcall(provider.rows) and pcall(provider.signature) and pcall(provider.visible))
  end
  -- a half-valid test keeps only what is valid
  publish(with({test = {state = 'used', backend = 'quantum', device = 5, vramMiB = 'x'}}))
  local test = provider.state().test
  assert(test.state == 'used' and test.backend == nil and test.device == nil and test.vramMiB == nil)
  -- an unknown failure code is kept as a failure, not dropped
  publish(with({job = {id = 'a', action = 'install', state = 'failed', code = {}}}))
  assert(provider.state().job == nil, 'not sent from here, so not shown')
`));

test('commands: three actions, one file, ids of this session; a failed write says so', () => run(`${moduleFixture}
  local provider = make()
  publish(with({}))
  for _, action in ipairs({'install', 'cancel', 'remove'}) do
    assert(provider.request(action) == true)
    local sent = written[#written]
    assert(sent.version == 1 and sent.action == action and type(sent.issuedAt) == 'number' and sent.id:match('^sess%-1:amd:%d+$'), sent.id)
    assert(provider.lastCommand().id == sent.id and provider.lastCommand().action == action)
  end
  assert(written[1].id ~= written[2].id and #written == 3)
  local _, message = provider.request('install'); assert(message == 'Starting the AMD setup…', message)
  _, message = provider.request('cancel'); assert(message == 'Cancelling…', message)
  _, message = provider.request('remove'); assert(message == 'Removing the AMD setup…', message)
  local count = #written
  local ok, text = provider.request('unknown')
  assert(ok == false and text == 'The request could not be sent. Try again.' and #written == count)
  failWrite = true
  ok, text = provider.request('install')
  assert(ok == false and text == 'The request could not be sent. Try again.')
`));

test('the state file is read at most every 1.5 s, at once after a command; the signature follows what a row shows', () => run(`${moduleFixture}
  local reads = 0
  local provider = make({readJSON = function() reads = reads + 1; return shown end})
  publish(with({})); provider.state(); provider.state(); provider.state()
  assert(reads == 1)
  clock = clock + 2; provider.state(); assert(reads == 2)
  local before = provider.signature()
  publish(with({installed = true}))
  assert(provider.signature() ~= before)
  before = provider.signature()
  publish(with({installed = true, job = {id = 'a:amd:1', action = 'install', state = 'downloading', doneMiB = 1, totalMiB = 10}}))
  assert(provider.signature() ~= before)
  before = provider.signature()
  publish(with({installed = true, job = {id = 'a:amd:1', action = 'install', state = 'downloading', doneMiB = 2, totalMiB = 10}}))
  assert(provider.signature() ~= before)
  provider.request('install'); provider.state(); assert(reads >= 4)
  provider.state(true); local forced = reads; provider.state(true); assert(reads == forced + 1)
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// Inside the real manager.lua, manager-ui.lua and nsui.lua
// ---------------------------------------------------------------------------------------------------------------------------------

const pageFixture = (withModule = true, source = amdSource) => nsuiHarness({
  modules: withModule ? {'omni-amd.lua': source} : {},
  absent: withModule ? [] : ['omni-amd.lua'],
}) + `
  convaiNotices.configure(function() return manager.developerMode() end)
`;

const stateFixture = `
  local clock = 1000
  os.clock = function() return clock end
  os.time = function() return clock end
  local function file(path, tag, value) jsonFixtures[tag] = value; files[path] = tag end
  local function service(tag, value) file('runtime/omni-amd-state.json', 'amd-' .. tag, value); clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager') end
  local function command() return jsonFixtures[files['runtime/omni-amd-command.json']] end
  local offered = {version = 1, offered = true, installed = false, arch = 'gfx1201', card = 'AMD Radeon RX 9070 XT', downloadMiB = 1480, diskMiB = 4100}
  local function voiceIds()
    local order = {}
    for _, category in ipairs(loaded.categories) do
      if category.id == 'voices' then for _, item in ipairs(category.settings) do order[#order + 1] = item.id end end
    end
    return table.concat(order, ',')
  end
`;

test('the Voices row shows only when the service says AMD is offered (or installed), right under the voice list', () => run(`${pageFixture()}${stateFixture}
  assert(invoke('tab:settings').ok)
  assert(row('omni-amd') == nil and not voiceIds():find('omni-amd', 1, true), voiceIds())
  service('none', {version = 1, offered = false, installed = false})
  assert(row('omni-amd') == nil)
  service('offered', offered)
  local ids = voiceIds()
  assert(ids:find('voiceProvider,omni%-amd,replyLanguage', 1), ids)
  assert(row('omni-amd').type == 'action' and row('omni-amd').value == 'Open' and row('omni-amd').label == 'OmniVoice for AMD')
  service('gone', {version = 1, offered = false, installed = false})
  assert(row('omni-amd') == nil)
  service('installed', {version = 1, offered = false, installed = true, card = 'AMD Radeon RX 9070 XT'})
  assert(row('omni-amd') ~= nil, 'a setup on disk keeps the row')
  for _, id in ipairs({'omni-amd'}) do
    assert(not (row(id).description .. row(id).label):lower():find('recommend', 1, true), id)
  end
`));

test('with Remote OmniVoice present, OmniVoice for AMD comes before Custom voices', () => run(`${nsuiHarness({modules: {'omni-amd.lua': amdSource, 'remote-omni.lua': read('remote-omni.lua')}})}${stateFixture}
  service('offered', offered)
  assert(invoke('tab:settings').ok)
  assert(voiceIds():find('voiceProvider,omni%-amd,custom%-voices,replyLanguage', 1), voiceIds())
`));

test('the page: the setup row, the MIOpen choice and a way back; the redraw follows the service', () => run(`${pageFixture()}${stateFixture}
  service('offered', offered)
  assert(invoke('tab:settings').ok and invoke('omni-amd').ok and managerUi.inspect().view == 'omni-amd')
  assert(loaded.categories[1].settings[1].id == 'omni-amd:back' and loaded.categories[1].settings[1].label == 'Back to settings')
  local pageIds = {}
  for _, category in ipairs(loaded.categories) do
    if category.id == 'omni-amd' then for _, item in ipairs(category.settings) do pageIds[#pageIds + 1] = item.id end end
  end
  assert(table.concat(pageIds, ',') == 'omni-amd-setup,amdMiopen', table.concat(pageIds, ','))
  assert(row('omni-amd-setup').type == 'action' and row('omni-amd-setup').value == 'Install' and row('omni-amd-setup').disabled == false)
  assert(row('amdMiopen').type == 'bool' and row('amdMiopen').value == true and row('amdMiopen').label == 'MIOpen convolutions (AMD)')
  assert(row('amdMiopen').description:find('MIOPEN_FIND_MODE=2 and MIOPEN_FIND_ENFORCE=1', 1, true) and row('amdMiopen').description:find('OmniVoice restarts with the new choice when it is idle.', 1, true))
  assert(not (row('amdMiopen').description .. row('amdMiopen').label):lower():find('recommend', 1, true))
  -- the service reports a download: the page shows it, and Install turns into Cancel
  assert(invoke('omni-amd-setup').ok)
  local sent = command()
  assert(sent.version == 1 and sent.action == 'install' and sent.id:find(':amd:', 1, true) and #sent.id <= 160, sent.id)
  service('downloading', {version = 1, offered = true, installed = false, card = 'AMD Radeon RX 9070 XT', downloadMiB = 1480, diskMiB = 4100,
    job = {id = sent.id, action = 'install', state = 'downloading', doneMiB = 740, totalMiB = 1480}})
  assert(row('omni-amd-setup').value == 'Cancel' and row('omni-amd-setup').label == 'Set up OmniVoice for AMD (50%)')
  assert(row('omni-amd-setup').description:find('^Downloading 740 of 1480 MB %(50%%%)'), row('omni-amd-setup').description)
  assert(invoke('omni-amd-setup').ok and command().action == 'cancel')
  service('done', {version = 1, offered = true, installed = true, card = 'AMD Radeon RX 9070 XT', downloadMiB = 1480, diskMiB = 4100,
    job = {id = command().id, action = 'cancel', state = 'cancelled'}})
  service('ready', {version = 1, offered = true, installed = true, card = 'AMD Radeon RX 9070 XT', downloadMiB = 1480, diskMiB = 4100,
    test = {state = 'used', backend = 'rocm', device = 'AMD Radeon RX 9070 XT', vramMiB = 16000}})
  assert(row('omni-amd-setup').value == 'Reinstall' and row('omni-amd-remove').value == 'Remove')
  assert(invoke('omni-amd-remove').ok and command().action == 'remove')
  assert(files['runtime/remote-omni-command.json'] == nil and files['runtime/custom-provider-command.json'] == nil, 'another channel was used')
  failSave = true
  local result = invoke('omni-amd-setup')
  assert(result.ok == false and result.error == 'The request could not be sent. Try again.', tostring(result.error))
  failSave = false
  assert(invoke('omni-amd:back').ok and managerUi.inspect().view == 'settings')
`));

test('without the module (or with one that fails) the Voices page is unchanged and the page is not offered', () => {
  run(`${pageFixture(false)}${stateFixture}
    service('offered', offered)
    assert(invoke('tab:settings').ok)
    assert(row('omni-amd') == nil and not invoke('omni-amd').ok)
    assert(not voiceIds():find('omni-amd', 1, true), voiceIds())
    assert(voiceIds():find('voiceProvider,replyLanguage', 1, true), voiceIds())
  `);
  const raising = amdSource.replace('function self.rows()', 'function self.rows() error("boom") end\n    function self.unusedRows()');
  run(`${pageFixture(true, raising)}${stateFixture}
    service('offered', offered)
    assert(invoke('tab:settings').ok and invoke('omni-amd').ok)
    assert(row('amdMiopen') and row('omni-amd-setup') == nil, 'the choice stays, the rows are left out')
  `);
  const raisingVisible = amdSource.replace('function self.visible(force)', 'function self.visible(force) error("boom") end\n    function self.unusedVisible(force)');
  run(`${pageFixture(true, raisingVisible)}${stateFixture}
    service('offered', offered)
    assert(invoke('tab:settings').ok and row('omni-amd') == nil)
  `);
  const broken = amdSource.replace('function M.new(options)', 'function M.new(options) error("no instance")');
  run(`${pageFixture(true, broken)}${stateFixture}
    service('offered', offered)
    assert(invoke('tab:settings').ok and row('omni-amd') == nil)
  `);
});

test('MIOpen is a saved setting: on by default, applied with the rest, survives a reload, and only a boolean is accepted', () => run(`${pageFixture()}${stateFixture}
  assert(manager.snapshot(player).settings.amdMiopen == true)
  service('offered', offered)
  assert(invoke('tab:settings').ok and invoke('omni-amd').ok)
  assert(row('amdMiopen').value == true)
  assert(registered.applyBatch('manager', {{id = 'amdMiopen', value = false}}).ok)
  assert(manager.snapshot(player).settings.amdMiopen == false and saved.amdMiopen == false)
  loaded = registered.loadMod('manager')
  assert(row('amdMiopen').value == false)
  assert(not registered.applyBatch('manager', {{id = 'amdMiopen', value = 'yes'}}).ok)
  assert(manager.snapshot(player).settings.amdMiopen == false, 'a refused value changes nothing')
  assert(registered.applyBatch('manager', {{id = 'amdMiopen', value = true}}).ok and saved.amdMiopen == true)
`));

test('the AMD route wording: the voice list says to set up first, the description points to the page, and the old wording is gone', () => {
  const ui = read('manager-ui.lua');
  const manager = read('manager.lua');
  const check = read('setup-check.lua');
  for (const text of [ui, manager, check]) {
    assert.ok(!text.includes('OmniVoice on AMD: experimental'));
    assert.ok(!text.includes('AMD experimental'));
    assert.ok(!text.includes('docs/OMNIVOICE_AMD.md in the mod'));
  }
  assert.ok(ui.includes('OmniVoice on AMD: set up first'));
  assert.ok(manager.includes('AMD: set up first'));
  assert.ok(check.includes('Settings > Voices > OmniVoice for AMD'));
});

test('release plumbing: the module is in the development file list and the catalogue reads it', () => {
  const development = JSON.parse(readFileSync(new URL('../scripts/development-files.json', import.meta.url), 'utf8'));
  assert.ok(JSON.stringify(development).includes('"mod/omni-amd.lua"'));
  assert.ok(readFileSync(new URL('../scripts/Extract-UiCatalog.mjs', import.meta.url), 'utf8').includes("'mod/omni-amd.lua'"));
});
