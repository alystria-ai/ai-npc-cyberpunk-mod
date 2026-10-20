// The game side of the player-state restore (mod/state-restore.lua and the readers of the four files it protects: settings.json in
// mod/manager.lua, phone-history.json in mod/phone-chat.lua, addon-settings.json in mod/addons.lua; npc-names.json is in
// bridge/npc-names.test.mjs). Under Mod Organizer 2 the conversation service puts the saved files back at its start
// (bridge/game-state.mjs); CET may read them before it has. The rules pinned here:
//   * a file that is missing or empty while a restore may still be coming is never mistaken for "nothing saved": the reader uses
//     defaults in memory only, writes nothing, and reads the file again once the restore is over;
//   * a signal left by the last game session is not this session's: the file is shipped empty and modified in place, so it is still there;
//   * nothing is asked on an ordinary start (the file is there), and nothing is read per frame while waiting;
//   * with no service (no signal ever), the reader carries on as it always did after a grace period.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, managerLua, diskLua, freshSettings, modSource} from './startup-lua-fixture.mjs';
import {LUA_HARNESS, runLua} from './addon-lua-harness.mjs';

const restoreSource = modSource('state-restore.lua');
const phoneSource = modSource('phone-chat.lua');
const luaString = text => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
const namesLua = `(function() local names = {} for name in pairs(files) do names[#names + 1] = name end table.sort(names) return names end)()`;

// The game process is 30 s old when the test starts (os.time() - os.clock() is when it began); floats, because fengari's integers are 32 bit.
const clockLua = `
  local wall, cpu = 1800000000.0, 30.0
  os.time = function() return wall end
  os.clock = function() return cpu end
  local function passTime(seconds) wall = wall + seconds; cpu = cpu + seconds end
  -- A finished restore written ageSeconds ago.
  local function signal(ageSeconds)
    files['runtime/state-restore.json'] = json.encode({version = 1, state = 'done', written = (wall - ageSeconds) * 1000, restored = {}, errors = 0})
  end
  local function newRestore() return (function() ${restoreSource} end)() end
`;
const customised = {...freshSettings, voice: false, conversationProvider: 'local', matureContent: true, localModel: 'standard', voiceVolume: 150,
  voiceProvider: 'omni', omniSteps: 32, omniReference: 'short', johnnyInHead: true, johnnyRemarks: 'rare', subtitleStyle: 'overhead'};

// --------------------------------------------------------------------------------------------------------- the module
test('a finished restore from this game session ends the wait, and the answer then stays', () => {
  const out = run(`${diskLua}${clockLua}
    local restore = newRestore()
    report('first', restore.waiting())
    signal(1)
    report('while', restore.waiting())     -- the signal is looked at once a second: not yet
    passTime(1)
    report('after', restore.waiting())
    files['runtime/state-restore.json'] = nil
    passTime(5)
    report('later', restore.waiting())
    report('ops', ops)
  `, {locale: false});
  assert.deepEqual([out.first, out.while, out.after, out.later], [true, true, false, false]);
  assert.deepEqual(out.ops, [], 'the module only reads');
});

test('a signal from an earlier game session is not this session\'s: the wait ends only after the grace period', () => {
  const out = run(`${diskLua}${clockLua}
    local restore = newRestore()
    signal(7200)                       -- the file the last launch left in its place, two hours old
    assert(restore.waiting())          -- the first question
    local answers = {}
    for second = 1, 130 do
      passTime(1)
      if not restore.waiting() then answers.endedAt = second; break end
    end
    report('endedAt', answers.endedAt)
    report('graceOk', restore.GRACE)
    report('reads', readCounts['runtime/state-restore.json'])
  `, {locale: false});
  assert.equal(out.graceOk, 120);
  assert.equal(out.endedAt, 120, 'the grace period is counted from the first question');
  assert(out.reads <= 125, `the signal is read about once a second, not on every question (${out.reads} reads)`);
});

test('an empty, cut-short, other-version or unfinished signal means not yet', () => {
  for (const raw of ['', '{"version":1,"state":"do', 'null', '[]', '{"version":2,"state":"done","written":9999999999999}',
    '{"version":1,"state":"working","written":9999999999999}', '{"version":1,"state":"done"}', '{"version":1,"state":"done","written":"now"}']) {
    const out = run(`${diskLua}${clockLua}
      local restore = newRestore()
      files['runtime/state-restore.json'] = ${luaString(raw)}
      passTime(3)
      report('waiting', restore.waiting())
    `, {locale: false});
    assert.equal(out.waiting, true, JSON.stringify(raw));
  }
});

test('the module schedules nothing and a game loop asks it nothing: it is a plain table with one function', () => {
  assert.doesNotMatch(restoreSource, /registerForEvent|onUpdate|Cron/);
  const out = run(`${diskLua}${clockLua}
    local restore = newRestore()
    local keys = {}
    for key in pairs(restore) do keys[#keys + 1] = key end
    table.sort(keys)
    report('keys', keys)
  `, {locale: false});
  assert.deepEqual(out.keys, ['GRACE', 'PATH', 'POLL', 'SLACK', 'waiting']);
});

test('init.lua loads the module into a global before any reader of the state files, and a failed load leaves it nil', () => {
  const initSource = modSource('init.lua');
  const at = initSource.indexOf("pcall(dofile, 'state-restore.lua')");
  assert(at > 0 && at < initSource.indexOf("local manager = dofile('manager.lua')") && at < initSource.indexOf("local phoneChat = dofile('phone-chat.lua')"));
  assert.match(initSource, /convaiStateRestore = restoreLoaded and type\(restoreModule\) == 'table' and restoreModule or nil/);
  for (const name of ['manager.lua', 'phone-chat.lua', 'addons.lua', 'npc-names.lua']) {
    const source = modSource(name);
    assert.match(source, /local restore = convaiStateRestore\r?\n\s*return restore ~= nil and restore\.waiting\(\) == true|restore\.waiting\(\) == true/, `${name} asks through the global, at call time`);
  }
});

// -------------------------------------------------------------------------------------------------------- settings.json
for (const [label, before] of [['missing', undefined], ['an empty file (the placeholder, or a crash)', '']]) {
  test(`settings.json ${label} while a restore may be on its way: defaults in memory, nothing written; the restored file is used once the signal comes`, () => {
    const out = run(`${managerLua}${clockLua}
      convaiStateRestore = newRestore()
      ${before === undefined ? '' : `files['runtime/settings.json'] = ${luaString(before)}`}
      local player, manager = newPlayer(), newManager()
      for _ = 1, 20 do manager.update(player, 0.1) end
      report('earlyOps', ops); report('earlyNames', ${namesLua}); report('earlyVoice', player.voice)
      report('earlyFeedback', manager.snapshot(player).feedback)
      -- Apply while the settings are held back: nothing is written, nothing replaces the saved file that is about to come back.
      manager.applySettings(player, {conversationProvider = 'mistral'})
      report('applyOps', ops)
      -- The service restores the file, then writes the signal.
      files['runtime/settings.json'] = ${luaString(JSON.stringify(customised))}
      local restoredText = files['runtime/settings.json']
      signal(2)
      passTime(1.5)
      manager.update(player, 0.1); manager.update(player, 0.1)
      report('lateOps', ops); report('lateVoice', player.voice); report('same', files['runtime/settings.json'] == restoredText)
      local settings = manager.snapshot(player).settings
      report('provider', settings.conversationProvider); report('mature', settings.matureContent); report('model', settings.localModel)
    `);
    assert.deepEqual(out.earlyOps, [], 'nothing is written while the restore may be coming');
    assert.deepEqual(out.earlyNames, before === undefined ? [] : ['runtime/settings.json']);
    assert.equal(out.earlyVoice, true, 'the defaults are what the game gets meanwhile');
    assert.doesNotMatch(String(out.earlyFeedback), /could not be saved/, 'holding the first save back is not a failed save, so the player is told nothing');
    assert.deepEqual(out.applyOps, [], 'an Apply while the settings are held back writes nothing');
    assert.deepEqual(out.lateOps, [], 'the restored file needs no rewrite');
    assert.equal(out.same, true, 'the saved file is untouched');
    assert.equal(out.lateVoice, false, 'the saved voice setting reached the game once the file was read');
    assert.deepEqual([out.provider, out.mature, out.model], ['local', true, 'standard'], 'the saved settings, not the defaults and not the held-back Apply');
  });
}

test('a restore that finds nothing saved (a first start) ends the wait: the defaults are written once, as before', () => {
  const out = run(`${managerLua}${clockLua}
    convaiStateRestore = newRestore()
    local player, manager = newPlayer(), newManager()
    manager.update(player, 0.1)
    report('heldBack', ops)
    signal(2); passTime(1.5)          -- the service answered: nothing to restore
    manager.update(player, 0.1); manager.update(player, 0.1)
    report('ops', ops); report('text', files['runtime/settings.json'])
  `);
  assert.deepEqual(out.heldBack, []);
  assert.deepEqual(out.ops, ['open-w runtime/settings.json.tmp', 'write runtime/settings.json.tmp', 'rename runtime/settings.json.tmp>runtime/settings.json']);
  assert.deepEqual(JSON.parse(out.text), freshSettings);
});

test('with no service (no signal, or one from the last session) the defaults are saved after the grace period, as they always were', () => {
  const out = run(`${managerLua}${clockLua}
    convaiStateRestore = newRestore()
    signal(7200)
    local player, manager = newPlayer(), newManager()
    manager.update(player, 0.1)
    passTime(100); manager.update(player, 0.1)
    report('at100', ops)
    passTime(25); manager.update(player, 0.1); manager.update(player, 0.1)
    report('at125', ops); report('text', files['runtime/settings.json'])
  `);
  assert.deepEqual(out.at100, [], 'still held back at 100 s');
  assert.equal(out.at125.length, 3, 'one save after the grace period');
  assert.deepEqual(JSON.parse(out.text), freshSettings);
});

test('an ordinary start never asks: settings.json is there, or a good backup is, and nothing is asked per frame', () => {
  const out = run(`${managerLua}${clockLua}
    local asked = 0
    convaiStateRestore = {waiting = function() asked = asked + 1; return true end}
    files['runtime/settings.json'] = ${luaString(JSON.stringify(customised))}
    local player, manager = newPlayer(), newManager()
    for _ = 1, 6000 do manager.update(player, 0.1) end
    report('asked', asked); report('ops', ops)
    asked = 0
    files['runtime/settings.json'] = '{"version":2,"voi'      -- cut off, with a good backup
    files['runtime/settings.json.previous'] = ${luaString(JSON.stringify(customised))}
    local again = newManager()
    for _ = 1, 100 do again.update(player, 0.1) end
    report('askedBackup', asked); report('provider', again.snapshot(player).settings.conversationProvider)
  `);
  assert.equal(out.asked, 0);
  assert.deepEqual(out.ops, []);
  assert.equal(out.askedBackup, 0, 'a readable backup is used at once, as before');
  assert.equal(out.provider, 'local');
});

test('while the settings are held back the module is asked at most once a second, never per frame', () => {
  const out = run(`${managerLua}${clockLua}
    convaiStateRestore = newRestore()
    local player, manager = newPlayer(), newManager()
    for _ = 1, 600 do manager.update(player, 0.1) end     -- 600 frames, no time passing
    report('reads', readCounts['runtime/state-restore.json'] or 0)
  `);
  assert(out.reads <= 1, `${out.reads} reads of the signal in 600 frames`);
});

// ------------------------------------------------------------------------------------------------------ phone-history.json
const phoneLua = `${diskLua}${clockLua}
  NewObject = function() return {} end
  files['phone-contacts.json'] = json.encode({{contact = 'judy', key = 'judy-alvarez'}, {contact = 'panam', key = 'panam-palmer'}})
  local function newPhone() local value = (function() ${phoneSource} end)(); value.resetPeriod = 0; value.resetIdlePeriod = 0; return value end
  local saveBinding = {version = 1, status = 'unavailable', generation = 1, historyScope = 'local-player-v1'}
  local contact, draft = 'judy', ''
  local player = {ConvaiPhoneChatContact = function() return contact end, ConvaiPhoneChatTick = function() end,
    ConvaiPhoneChatClearContacts = function() end, ConvaiPhoneChatRegisterContact = function() end,
    ConvaiPhoneChatDraft = function() return {contact = contact, text = draft} end,
    ConvaiPhoneChatTakeSubmission = function() return nil end,
    ConvaiPhoneChatPresent = function() end}
  local function configure(m)
    m.configure({{key = 'judy-alvarez'}, {key = 'panam-palmer'}},
      {profileEnabled = function() return true end, disappearingMessages = function() return false end},
      {captureBinding = function() return saveBinding end, captureWorldKnowledge = function() return {version = 1, status = 'unavailable'} end})
  end
  local function update(m) for _ = 1, 8 do m.update(player, 0) end end
  local saved = {version = 3, buckets = {['phone-local-player:v1'] = {identity = {version = 1, status = 'unavailable', generation = 1, historyScope = 'local-player-v1'},
    history = {judy = {{text = 'Hello Judy', sent = true}, {text = 'Hey V', sent = false}}}, drafts = {}}},
    legacy = {}, contactProfiles = {}, memoryResetsApplied = {}}
`;

test('phone-history.json missing while a restore may be on its way: nothing binds or is saved; the restored chats are read after the signal', () => {
  const out = run(`${phoneLua}
    convaiStateRestore = newRestore()
    local m = newPhone(); configure(m)
    report('pending', m.storePending)
    update(m); update(m)
    report('bound', m.world ~= nil); report('earlyOps', ops)
    -- The service restores the chats, then writes the signal.
    local text = json.encode(saved)
    files['runtime/phone-history.json'] = text
    signal(2); passTime(1.5)
    update(m)
    report('boundLater', m.world ~= nil); report('history', m.history.judy); report('pendingLater', m.storePending)
    local stored = json.decode(files['runtime/phone-history.json'])
    report('kept', stored.buckets['phone-local-player:v1'].history.judy)
  `);
  assert.equal(out.pending, true);
  assert.equal(out.bound, false, 'the phone chat does not bind to an empty store while a restore may be coming');
  assert.deepEqual(out.earlyOps, [], 'and writes nothing');
  assert.equal(out.boundLater, true);
  assert.equal(out.pendingLater, false);
  assert.deepEqual(out.history, [{text: 'Hello Judy', sent: true}, {text: 'Hey V', sent: false}], 'the saved chats are what V sees');
  assert.deepEqual(out.kept, out.history, 'and what is saved afterwards');
});

test('phone-history.json missing and the restore finished: the phone chat starts with an empty history and saves it, as before', () => {
  const out = run(`${phoneLua}
    signal(2)
    local m = newPhone(); configure(m)
    update(m)
    report('pending', m.storePending); report('bound', m.world ~= nil); report('saved', files['runtime/phone-history.json'] ~= nil)
  `);
  assert.deepEqual([out.pending, out.bound, out.saved], [false, true, true]);
});

test('an ordinary phone start (the history is there) never asks, and the phone tick asks nothing per frame', () => {
  const out = run(`${phoneLua}
    local asked = 0
    convaiStateRestore = {waiting = function() asked = asked + 1; return true end}
    files['runtime/phone-history.json'] = json.encode(saved)
    local m = newPhone(); configure(m)
    for _ = 1, 600 do m.update(player, 0.016) end
    report('asked', asked); report('history', m.history.judy)
  `);
  assert.equal(out.asked, 0);
  assert.equal(out.history.length, 2);
});

test('held-back phone chats are checked on the 10 Hz tick, and a signal from the last session does not release them', () => {
  const out = run(`${phoneLua}
    local asked = 0
    local real = newRestore()
    convaiStateRestore = {waiting = function() asked = asked + 1; return real.waiting() end}
    signal(7200)
    local m = newPhone(); configure(m)
    local atConfigure = asked
    for _ = 1, 600 do m.update(player, 0.016) end         -- about ten seconds of frames, no wall time passing
    report('atConfigure', atConfigure); report('askedPerSecond', asked - atConfigure); report('bound', m.world ~= nil)
    passTime(125)
    for _ = 1, 20 do m.update(player, 0.016) end
    report('boundAfterGrace', m.world ~= nil)
  `);
  assert.equal(out.atConfigure, 1);
  assert(out.askedPerSecond <= 110, `asked ${out.askedPerSecond} times in ten seconds of frames (the 10 Hz tick, not every frame)`);
  assert.equal(out.bound, false);
  assert.equal(out.boundAfterGrace, true);
});

// ----------------------------------------------------------------------------------------------------- addon-settings.json
// fengari's integers are 32 bit and this harness's encoder writes whole numbers with %d, so the clock is small here (1e6 s, 1e9 ms).
const addonRestore = `
  local wall, cpu = 1000000.0, 30.0
  os.time = function() return wall end
  os.clock = function() return cpu end
  local function passTime(seconds) wall = wall + seconds; cpu = cpu + seconds end
  local function signal(ageSeconds)
    files['runtime/state-restore.json'] = json.encode({version = 1, state = 'done', written = (wall - ageSeconds) * 1000, restored = {}, errors = 0})
  end
  convaiStateRestore = (function() ${restoreSource} end)()
`;

test('addon-settings.json missing while a restore may be on its way: nothing is written; the saved values reach the add-on after the signal', () => {
  const out = runLua(`${addonRestore}
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    assert(handle:settings({title = 'Skippy', items = {
        {id = 'personality', label = 'Personality', kind = 'select', default = 1, elements = {'Stone Cold Killer', 'Puppy-Loving Pacifist'}},
        {id = 'remarks', label = 'Combat remarks', kind = 'bool', default = true}}}))
    local early = handle:setting('personality')
    -- The player changes a setting in the first seconds: held, not saved over the file that is about to come back.
    assert(M.stageSetting('addon:skippy:remarks', false))
    local savedEarly = M.commitSettings()
    local wroteEarly = files['runtime/addon-settings.json'] ~= nil or files['runtime/addon-settings.json.tmp'] ~= nil
    -- The service restores the file, then writes the signal.
    local restored = json.encode({version = 1, addons = {skippy = {personality = 2, remarks = true, remarkGap = 7, remarkCap = 4, replaceGameLines = true, markLines = true}}})
    files['runtime/addon-settings.json'] = restored
    signal(2); passTime(1.5)
    M.settingsSections()
    return table.concat({tostring(early), tostring(savedEarly), tostring(wroteEarly), tostring(handle:setting('personality')),
      tostring(handle:setting('remarks')), tostring(files['runtime/addon-settings.json'] == restored)}, '|')
  `);
  assert.equal(out, '1|false|false|2|true|true', 'defaults meanwhile; the early save refused; the saved values arrive; the saved file was never replaced');
});

test('addon-settings.json: a commit after the restore saves the merged values, and an ordinary start never asks', () => {
  const out = runLua(`${addonRestore}
    local asked = 0
    local real = convaiStateRestore
    convaiStateRestore = {waiting = function() asked = asked + 1; return real.waiting() end}
    files['runtime/addon-settings.json'] = json.encode({version = 1, addons = {skippy = {personality = 2}, other = {x = 1}}})
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    assert(handle:settings({title = 'Skippy', items = {{id = 'personality', label = 'Personality', kind = 'select', default = 1, elements = {'a', 'b'}}}}))
    assert(M.stageSetting('addon:skippy:personality', 1) and M.commitSettings())
    local doc = json.decode(files['runtime/addon-settings.json'])
    return table.concat({tostring(asked), tostring(doc.addons.skippy.personality), tostring(doc.addons.other.x)}, '|')
  `);
  assert.equal(out, '0|1|1', 'never asked; the player\'s change saved; another add-on\'s saved values kept');
});

test('addon-settings.json with no service: the first save works after the grace period', () => {
  const out = runLua(`${addonRestore}
    signal(7200)
    local handle = assert(M.public.register({id = 'skippy', name = 'Skippy', version = '1.0.0', requires = '1.0'}))
    assert(handle:settings({title = 'Skippy', items = {{id = 'remarks', label = 'Combat remarks', kind = 'bool', default = true}}}))
    assert(M.stageSetting('addon:skippy:remarks', false))
    local early = M.commitSettings()
    passTime(125)
    assert(M.stageSetting('addon:skippy:remarks', false))
    local late = M.commitSettings()
    return table.concat({tostring(early), tostring(late), tostring(files['runtime/addon-settings.json'] ~= nil)}, '|')
  `);
  assert.equal(out, 'false|true|true');
  assert.match(LUA_HARNESS, /files, opened/);
});
