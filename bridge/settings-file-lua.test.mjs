// The player's settings file, as mod/manager.lua reads and writes it at startup (runtime/settings.json, class "state": it keeps its
// temp file and backup, unlike the exchange files). The real manager.lua runs over the fake disk and the strict JSON codec of
// startup-lua-fixture.mjs, so a 0-byte file, a cut-short file and a failed rename behave as they do in the game.
// What is pinned here, and was only pinned one setting at a time before:
//   * a first start writes exactly the documented defaults, once, and a second start from that file writes nothing;
//   * an empty, cut-short or foreign file never throws, never loses a good backup's values and falls back to the defaults otherwise;
//   * a hand edit with a wrong type in any key lands on that key's default, and keys the manager does not know are kept;
//   * the save is safe at every step: a failure or a crash at any point leaves the old or the new settings for the next start.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, managerLua, freshSettings} from './startup-lua-fixture.mjs';

const namesLua = `(function() local names = {} for name in pairs(files) do names[#names + 1] = name end table.sort(names) return names end)()`;
const luaString = text => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;

// A normalized settings table that differs from the defaults in values that matter to the bridge (provider, Mature, model, voice).
const customised = {
  ...freshSettings, voice: false, conversationProvider: 'local', matureContent: true, localModel: 'standard', voiceVolume: 150,
  voiceProvider: 'omni', omniSteps: 32, omniReference: 'short', johnnyRemarks: 'rare', subtitleStyle: 'overhead',
  naturalSpeech: true, expressiveEmotions: false,
};

test('a first start writes exactly the documented defaults, once; a second start from that file writes nothing', () => {
  const out = run(`${managerLua}
    local player = newPlayer()
    local first = newManager()
    first.update(player, 0.1)
    report('ops', ops); report('text', settingsText())
    report('names', ${namesLua})
    -- Ten minutes of ordinary ticks change nothing on disk, and neither does a restart from the written file.
    resetOps()
    for _ = 1, 6000 do first.update(player, 0.1) end
    local second = newManager()
    for _ = 1, 50 do second.update(player, 0.1) end
    report('later', ops)
    report('again', settingsText())
  `);
  assert.deepEqual(out.ops, ['open-w runtime/settings.json.tmp', 'write runtime/settings.json.tmp', 'rename runtime/settings.json.tmp>runtime/settings.json']);
  assert.deepEqual(out.names, ['runtime/settings.json'], 'no temp or backup file is left behind');
  assert.deepEqual(JSON.parse(out.text), freshSettings);
  assert.deepEqual(out.later, [], 'unchanged settings are never written again');
  assert.equal(out.again, out.text);
});

// What a player or a crash can leave in the settings file's place. The first four are the commonest: the 0-byte file, a file cut off by
// a full disk, a copy-paste of something else, and a JSON value that is not an object.
const unreadable = {
  'a 0-byte file': '',
  'only whitespace': ' \r\n\t ',
  'a file cut off in the middle of a key': '{"version":2,"voice":false,"conversationPro',
  'text that is not JSON': 'not json at all',
  'JSON null': 'null',
  'a bare number': '42',
  'a bare string': '"settings"',
  'a bare true': 'true',
};

for (const [label, text] of Object.entries(unreadable)) {
  test(`${label} in place of settings.json: no error, the defaults load and a valid file is written back`, () => {
    const out = run(`${managerLua}
      files['runtime/settings.json'] = ${luaString(text)}
      local manager = newManager()
      local player = newPlayer()
      local ok, problem = pcall(manager.update, player, 0.1)
      report('ok', ok); report('problem', tostring(problem))
      report('text', settingsText())
      report('names', ${namesLua})
    `);
    assert.equal(out.ok, true, out.problem);
    assert.deepEqual(JSON.parse(out.text), freshSettings);
    assert.deepEqual(out.names, ['runtime/settings.json']);
  });

  test(`${label} in place of settings.json: a good backup's settings are used, not the defaults`, () => {
    const out = run(`${managerLua}
      files['runtime/settings.json'] = ${luaString(text)}
      files['runtime/settings.json.previous'] = ${luaString(JSON.stringify(customised))}
      local manager = newManager()
      local player = newPlayer()
      local snapshot = manager.snapshot(player)
      report('settings', snapshot.settings)
      report('writes', writes('runtime/settings.json.tmp'))
    `);
    for (const key of ['voice', 'conversationProvider', 'matureContent', 'localModel', 'voiceVolume', 'voiceProvider', 'omniSteps',
      'omniReference', 'johnnyRemarks', 'subtitleStyle', 'naturalSpeech', 'expressiveEmotions']) {
      assert.deepEqual(out.settings[key], customised[key], `${key} came back from the backup`);
    }
    assert.equal(out.writes, 0, 'a normalized backup needs no rewrite just to be loaded');
  });
}

test('a file with a byte order mark, as Windows PowerShell and older Notepad write it, still loads its settings', () => {
  const out = run(`${managerLua}
    files['runtime/settings.json'] = '\\239\\187\\191' .. ${luaString(JSON.stringify({...freshSettings, conversationProvider: 'local', voice: false}))}
    local manager = newManager()
    report('settings', manager.snapshot(newPlayer()).settings)
  `);
  assert.equal(out.settings.conversationProvider, 'local');
  assert.equal(out.settings.voice, false);
});

test('a settings.json that is a valid JSON array is read as an empty settings table, with no error', () => {
  const out = run(`${managerLua}
    files['runtime/settings.json'] = '[]'
    local manager = newManager()
    local ok, problem = pcall(manager.update, newPlayer(), 0.1)
    report('ok', ok); report('problem', tostring(problem)); report('text', settingsText())
  `);
  assert.equal(out.ok, true, out.problem);
  assert.deepEqual(JSON.parse(out.text), freshSettings);
});

test('a newer good settings.json is used over an older backup, and the next save removes the stale backup and leaves no temp file', () => {
  const out = run(`${managerLua}
    files['runtime/settings.json'] = ${luaString(JSON.stringify({...freshSettings, conversationProvider: 'mistral'}))}
    files['runtime/settings.json.previous'] = ${luaString(JSON.stringify({...freshSettings, conversationProvider: 'local'}))}
    files['runtime/settings.json.tmp'] = '{"cut off'
    local manager = newManager()
    local player = newPlayer()
    report('before', manager.snapshot(player).settings.conversationProvider)
    assert(manager.applySettings(player, {subtitleStyle = 'overhead'}))
    report('after', manager.snapshot(player).settings.conversationProvider)
    report('text', settingsText())
    report('names', ${namesLua})
  `);
  assert.equal(out.before, 'mistral');
  assert.equal(out.after, 'mistral');
  assert.equal(JSON.parse(out.text).subtitleStyle, 'overhead');
  assert.deepEqual(out.names, ['runtime/settings.json']);
});

// Every key, one wrong type each. A hand edit (the docs name keys to edit by hand) or a bad paste must land on the default of that key,
// never on a value the code then treats as set.
test('a wrong type or an unknown choice in any setting lands on that setting\'s default, and the file is rewritten clean', () => {
  const wrong = {
    voice: 'yes', subtitles: 1, subtitleStyle: 3, audioDelay: 'fast', voiceVolume: 'loud', developerMode: 'true', useOwnConvaiKey: 0,
    conversationProvider: 7, battleReactions: 'on', lootReactions: [], bodyGestures: 'no', autoConnectNearby: 'yes', holocallLiveImage: 'x',
    gameDialogueContext: 2, decisionLedger: 'y', witnessReceipts: 9, eyeContactHeight: 'high', headFollowStrength: 99,
    voiceProvider: 12, omniSteps: '16', omniReference: 4, archetypeConversations: 'maybe', storyConversations: 3, johnnyInHead: 'x',
    johnnyRemarks: 5, naturalSpeech: 'x', expressiveEmotions: 'x', followUpInterest: 'x', matureContent: 'x', localModel: 'has space',
    multilingualConversations: 'x', vVoice: 'x', vVoiceEngine: 'elevenlabs', enabledByKey: 'all', relationshipModes: 'friends',
    uiLanguage: 'klingon', keepPreparedVoices: 'always', expressiveEmotionsChosen: 'x', vVoiceChosen: 'x', holocallLiveImageChosen: 'x',
  };
  const out = run(`${managerLua}
    files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, ...wrong}))}
    local manager = newManager()
    local ok, problem = pcall(manager.update, newPlayer(), 0.1)
    report('ok', ok); report('problem', tostring(problem)); report('text', settingsText())
    report('language', manager.interfaceLanguage())
  `);
  assert.equal(out.ok, true, out.problem);
  assert.deepEqual(JSON.parse(out.text), freshSettings);
  assert.equal(out.language, 'auto');
});

test('out-of-range and over-long values are replaced: model ids over 80 characters, a voice volume of 5000, a negative delay', () => {
  const out = run(`${managerLua}
    files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, localModel: 'm'.repeat(81), voiceVolume: 5000, audioDelay: -10, eyeContactHeight: 0.07, voiceProvider: 'POCKET TTS (fast)'}))}
    local snapshot = newManager().snapshot(newPlayer())
    report('settings', snapshot.settings)
  `);
  assert.equal(out.settings.localModel, 'auto');
  assert.equal(out.settings.voiceVolume, 100);
  assert.equal(out.settings.audioDelay, 'auto');
  assert.equal(out.settings.eyeContactHeight, 0);
  assert.equal(out.settings.voiceProvider, 'pocket', 'any Pocket variant name is the one Pocket entry');
});

test('keys the manager does not know are kept through an Apply: the developer-only keys the bridge reads and a future key', () => {
  const extras = {
    replyStreaming: false, emotionSelector: 'legacy', visionTransport: 'upload', visionWaitMs: 0, visionDebugLastSent: true,
    someFutureFeature: {mode: 'x', limits: [1, 2, 3], nested: {deep: true}}, aNumber: 7.5, aNote: 'kept as written',
  };
  const out = run(`${managerLua}
    files['runtime/settings.json'] = ${luaString(JSON.stringify({...freshSettings, ...extras}))}
    local manager = newManager()
    local player = newPlayer()
    assert(manager.applySettings(player, {conversationProvider = 'local', subtitleStyle = 'overhead'}))
    report('text', settingsText())
    -- And through a second Apply from a restart: the keys are never dropped by a save.
    local again = newManager()
    assert(again.applySettings(player, {voiceVolume = 80}))
    report('twice', settingsText())
  `);
  for (const text of [out.text, out.twice]) {
    const saved = JSON.parse(text);
    for (const [key, value] of Object.entries(extras)) assert.deepEqual(saved[key], value, `${key} survived`);
  }
  assert.equal(JSON.parse(out.twice).conversationProvider, 'local');
  assert.equal(JSON.parse(out.twice).voiceVolume, 80);
});

// Old and odd files. Each must settle in one save: the first start normalizes and writes, the file it wrote loads to the same settings
// and a start from it writes nothing. A rule that flipped a value back and forth would rewrite the file at every start.
const oldFiles = {
  'a version 1 file with the legacy enabled list and the old hybrid voice': {voice: false, enabled: [false, true, true, true, true, true], voiceProvider: 'hybrid', omniSteps: 32},
  'Mature content beside a cloud provider': {version: 2, conversationProvider: 'mistral', matureContent: true,
    matureRestore: {conversationProvider: {before: 'convai', set: 'local'}}},
  'Multilingual with Pocket TTS and Natural speech': {version: 2, multilingualConversations: true, voiceProvider: 'pocket', naturalSpeech: true},
  'a tag setting beside the Convai cloud voice': {version: 2, voiceProvider: 'convai', naturalSpeech: true, expressiveEmotions: true},
  'the Inworld voice without Developer mode': {version: 2, voiceProvider: 'inworld'},
  'the removed Groq provider': {version: 2, conversationProvider: 'groq'},
  'the first version defaults saved as false': {version: 2, holocallLiveImage: false, vVoice: false},
  'false chosen by the player for those two': {version: 2, holocallLiveImage: false, holocallLiveImageChosen: true, vVoice: false, vVoiceChosen: true},
  'retired keys': {version: 2, followUpQuestions: true, companionVision: false, disappearingMessages: true},
  'Voxtral for V beside Mature content': {version: 2, conversationProvider: 'local', matureContent: true, vVoiceEngine: 'voxtral'},
  'a fully customised current file': customised,
};

for (const [label, content] of Object.entries(oldFiles)) {
  test(`${label}: settles in one save and a restart from the result writes nothing`, () => {
    const out = run(`${managerLua}
      files['runtime/settings.json'] = ${luaString(JSON.stringify(content))}
      local player = newPlayer()
      local first = newManager()
      first.update(player, 0.1)
      report('firstSettings', first.snapshot(player).settings)
      report('firstWrites', writes('runtime/settings.json.tmp'))
      report('written', settingsText())
      resetOps()
      local second = newManager()
      second.update(player, 0.1)
      report('secondWrites', writes('runtime/settings.json.tmp'))
      report('secondSettings', second.snapshot(player).settings)
      -- The file on disk is the normal form: saving the loaded settings again produces the same content.
      assert(second.applySettings(player, {}))
      report('rewritten', settingsText())
    `);
    assert.equal(out.secondWrites, 0, 'a restart rewrote the file');
    assert.deepEqual(out.secondSettings, out.firstSettings);
    assert.deepEqual(JSON.parse(out.rewritten), JSON.parse(out.written), 'the saved file is not the loaded settings in normal form');
    assert.ok(out.firstWrites <= 1);
  });
}

test('reading the setting of the moment each frame reads the file once, and again only after a reset; Developer mode is off before the load', () => {
  const out = run(`${managerLua}
    local manager = newManager()
    report('before', manager.developerMode())
    report('beforeReads', (readCounts['runtime/settings.json'] or 0) + (readCounts['runtime/settings.json.previous'] or 0))
    for _ = 1, 500 do
      manager.interfaceLanguage(); manager.developerMode(); manager.battleReactions(); manager.lootReactions(); manager.subtitleStyle()
      manager.naturalSpeech(); manager.expressiveEmotions(); manager.vVoice(); manager.vVoiceEngine(); manager.johnnyInHead(); manager.johnnyRemarks()
      manager.autoConnectNearby(); manager.storyConversations(); manager.archetypeConversations()
    end
    report('reads', readCounts['runtime/settings.json'])
    report('backupReads', readCounts['runtime/settings.json.previous'])
    report('writes', #ops)
    manager.reset()
    manager.interfaceLanguage()
    report('afterReset', readCounts['runtime/settings.json'])
  `);
  assert.equal(out.before, false);
  assert.equal(out.beforeReads, 0, 'asking before the first load reads nothing');
  assert.equal(out.reads, 1, 'settings.json is read once, not once per frame');
  assert.equal(out.backupReads, 1, 'a missing file looks for the backup once');
  assert.equal(out.writes, 0, 'a getter never writes: the first save belongs to the update with the player');
  assert.equal(out.afterReset, 2, 'a world change loads the file again');
});

test('native voice and subtitle switches write once each, only when they change, and 0.5 s party ticks stay cheap', () => {
  const out = run(`${managerLua}
    local player = newPlayer()
    local manager = newManager()
    manager.update(player, 0.1)
    resetOps()
    local partyReads = 0
    local list = companionApi.list
    companionApi.list = function() partyReads = partyReads + 1; return list() end
    for _ = 1, 100 do manager.update(player, 0.1) end
    report('idleOps', ops); report('partyReads', partyReads)
    report('stateReads', {voice = readCounts['runtime/local-voice-state.json'], mistral = readCounts['runtime/mistral-state.json'],
      ownKey = readCounts['runtime/own-key-state.json'], memory = readCounts['runtime/memory-status.json'], paid = readCounts['runtime/paid-tier-state.json']})
    resetOps()
    player.voice = false
    manager.update(player, 0.1)
    report('voiceOps', ops)
    for _ = 1, 20 do manager.update(player, 0.1) end
    report('voiceOpsLater', ops)
    resetOps()
    player.subtitles = false
    manager.update(player, 0.1)
    report('subtitleWrites', writes('runtime/settings.json.tmp'))
    report('saved', {voice = settingsTable().voice, subtitles = settingsTable().subtitles})
  `);
  assert.deepEqual(out.idleOps, []);
  assert.ok(out.partyReads >= 19 && out.partyReads <= 21, `the party list is read about every half second: ${out.partyReads}`);
  assert.ok(out.stateReads.voice <= 6, `the voice state is read every 2 s: ${out.stateReads.voice}`);
  assert.equal(out.stateReads.mistral, undefined, 'the provider status is not read per tick while its page is closed');
  assert.equal(out.stateReads.ownKey, undefined);
  assert.equal(out.stateReads.memory, undefined);
  assert.equal(out.stateReads.paid, undefined);
  assert.deepEqual(out.voiceOps, ['open-w runtime/settings.json.tmp', 'write runtime/settings.json.tmp', 'remove runtime/settings.json.previous',
    'rename runtime/settings.json>runtime/settings.json.previous', 'rename runtime/settings.json.tmp>runtime/settings.json', 'remove runtime/settings.json.previous']);
  assert.deepEqual(out.voiceOpsLater, out.voiceOps, 'the change is saved once, not on every later tick');
  assert.equal(out.subtitleWrites, 1);
  assert.deepEqual(out.saved, {voice: false, subtitles: false});
});

// The temp-file and backup protection, step by step. Two values tell which copy a restart found: the Convai free tier (the old file) and
// Local AI (what the Apply sets). A successful save has six steps: open and write the temp file, remove the backup, move the old file
// aside, put the temp file in place, remove the backup.
const oldFile = JSON.stringify({...freshSettings, conversationProvider: 'convai'});
const savePrelude = start => `${managerLua}
  local oldText = ${luaString(oldFile)}
  ${start}
  local player = newPlayer()
  local manager = newManager()
  manager.snapshot(player)
  resetOps()
`;

test('a crash at any step of the save leaves the old or the new settings for the next start, never the defaults', () => {
  for (let crash = 1; crash <= 6; crash += 1) {
    const out = run(`${savePrelude(`files['runtime/settings.json'] = oldText`)}
      crashAt = ${crash}
      local ok = pcall(function() manager.applySettings(player, {conversationProvider = 'local', voiceVolume = 80}) end)
      report('crashed', not ok)
      crashAt = nil
      local restarted = newManager().snapshot(newPlayer()).settings
      report('provider', restarted.conversationProvider); report('volume', restarted.voiceVolume)
    `);
    assert.equal(out.crashed, true, `step ${crash} existed`);
    // One apply is one file: both of its values come back together or not at all.
    assert.ok((out.provider === 'convai' && out.volume === 100) || (out.provider === 'local' && out.volume === 80), `step ${crash}: ${out.provider} ${out.volume}`);
    if (crash <= 4) assert.equal(out.provider, 'convai', `before the new file is in place (step ${crash}) the old settings stand`);
    if (crash === 6) assert.equal(out.provider, 'local', 'once the new file is in place the new settings stand');
  }
});

test('a crash at any step with an older backup lying around still finds a settings file and never the defaults', () => {
  for (let crash = 1; crash <= 6; crash += 1) {
    const out = run(`${savePrelude(`files['runtime/settings.json'] = oldText
      files['runtime/settings.json.previous'] = ${luaString(JSON.stringify({...freshSettings, conversationProvider: 'mistral'}))}`)}
      crashAt = ${crash}
      pcall(function() manager.applySettings(player, {conversationProvider = 'local'}) end)
      crashAt = nil
      report('provider', newManager().snapshot(newPlayer()).settings.conversationProvider)
    `);
    assert.ok(['convai', 'local'].includes(out.provider), `crash at step ${crash} found ${out.provider}`);
  }
});

test('a failed save step leaves the old file in place and reports the failure, whichever step fails', () => {
  const failures = {
    'the temp file cannot be opened': `kind == 'open-w' and path == 'runtime/settings.json.tmp'`,
    'the temp file cannot be written': `kind == 'write' and path == 'runtime/settings.json.tmp'`,
    'the old file cannot be moved aside': `kind == 'rename' and path == 'runtime/settings.json>runtime/settings.json.previous'`,
    'the temp file cannot be moved into place': `kind == 'rename' and path == 'runtime/settings.json.tmp>runtime/settings.json'`,
  };
  for (const [label, condition] of Object.entries(failures)) {
    const out = run(`${savePrelude(`files['runtime/settings.json'] = oldText`)}
      failOn = function(kind, path) return ${condition} end
      local applied, reason = manager.applySettings(player, {conversationProvider = 'local', subtitleStyle = 'overhead'})
      failOn = nil
      report('applied', applied); report('reason', tostring(reason))
      report('onDisk', files['runtime/settings.json'] == oldText)
      report('inMemory', manager.snapshot(player).settings.conversationProvider)
      report('restart', newManager().snapshot(newPlayer()).settings.conversationProvider)
      report('backup', files['runtime/settings.json.previous'])
    `);
    assert.equal(out.applied, false, label);
    assert.match(out.reason, /could not be saved/, label);
    assert.equal(out.onDisk, true, `${label}: the old file is still the one on disk`);
    assert.equal(out.inMemory, 'convai', `${label}: nothing took effect`);
    assert.equal(out.restart, 'convai', label);
    assert.equal(out.backup, null, `${label}: no stray backup is left`);
  }
});

// The backup is the only good copy while settings.json is unreadable. Loading falls back to it, so the next save must not delete it before
// the new file is safely in place. It first takes the unreadable file's place (remove it, rename the backup over it), and the ordinary six
// steps follow: eight steps in all, and a failure or a crash at any of them leaves a good copy for the next start.
const corruptTarget = `files['runtime/settings.json'] = ''
  files['runtime/settings.json.previous'] = ${luaString(JSON.stringify({...freshSettings, conversationProvider: 'local', voiceVolume: 150}))}`;

test('an unreadable settings.json with a good backup: a save that cannot move the old file aside keeps the backup, so the next start still has the settings', () => {
  const out = run(`${managerLua}
    ${corruptTarget}
    local player = newPlayer()
    local manager = newManager()
    assert(manager.snapshot(player).settings.conversationProvider == 'local')
    failOn = function(kind, path) return kind == 'rename' and path == 'runtime/settings.json>runtime/settings.json.previous' end
    local applied = manager.applySettings(player, {subtitleStyle = 'overhead'})
    failOn = nil
    report('applied', applied)
    local restarted = newManager().snapshot(newPlayer()).settings
    report('provider', restarted.conversationProvider); report('volume', restarted.voiceVolume)
  `);
  assert.equal(out.applied, false);
  assert.equal(out.provider, 'local', 'the settings of the backup were lost');
  assert.equal(out.volume, 150);
});

test('an unreadable settings.json with a good backup: a crash at any step of the next save still leaves the settings for the next start', () => {
  const failures = [];
  for (let crash = 1; crash <= 8; crash += 1) {
    const out = run(`${managerLua}
      ${corruptTarget}
      local player = newPlayer()
      local manager = newManager()
      manager.snapshot(player)
      resetOps()
      crashAt = ${crash}
      pcall(function() manager.applySettings(player, {subtitleStyle = 'overhead'}) end)
      crashAt = nil
      report('provider', newManager().snapshot(newPlayer()).settings.conversationProvider)
    `);
    if (out.provider !== 'local') failures.push(`step ${crash}: ${out.provider}`);
  }
  assert.deepEqual(failures, []);
});

test('an unreadable settings.json with a good backup: the next successful save keeps the backup\'s settings and leaves one clean file', () => {
  const out = run(`${managerLua}
    ${corruptTarget}
    local player = newPlayer()
    local manager = newManager()
    assert(manager.applySettings(player, {subtitleStyle = 'overhead'}))
    report('text', settingsText())
    report('names', ${namesLua})
  `);
  const saved = JSON.parse(out.text);
  assert.equal(saved.conversationProvider, 'local');
  assert.equal(saved.voiceVolume, 150);
  assert.equal(saved.subtitleStyle, 'overhead');
  assert.deepEqual(out.names, ['runtime/settings.json']);
});

test('a start with the settings file missing but its backup present (a crash between the two renames) loads the backup, and the next save writes the file again', () => {
  const out = run(`${managerLua}
    files['runtime/settings.json.previous'] = ${luaString(JSON.stringify({...freshSettings, conversationProvider: 'mistral'}))}
    files['runtime/settings.json.tmp'] = ${luaString(JSON.stringify({...freshSettings, conversationProvider: 'local'}))}
    local player = newPlayer()
    local manager = newManager()
    report('loaded', manager.snapshot(player).settings.conversationProvider)
    assert(manager.applySettings(player, {subtitleStyle = 'overhead'}))
    report('after', settingsTable().conversationProvider)
    report('names', ${namesLua})
  `);
  assert.equal(out.loaded, 'mistral', 'the backup is what is left of the last good save');
  assert.equal(out.after, 'mistral');
  assert.ok(out.names.includes('runtime/settings.json'));
});
