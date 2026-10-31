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
  ...freshSettings, voice: false, conversationProvider: 'local', matureContent: true, localModel: 'standard', voiceVolume: 200, vVoiceVolume: 80,
  voiceProvider: 'omni', omniSteps: 32, omniReference: 'short', johnnyInHead: true, johnnyRemarks: 'rare', subtitleStyle: 'overhead',
  naturalSpeech: true, replyLanguage: 'ja',
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
    for (const key of ['voice', 'conversationProvider', 'matureContent', 'localModel', 'voiceVolume', 'vVoiceVolume', 'voiceProvider', 'omniSteps',
      'omniReference', 'johnnyInHead', 'johnnyRemarks', 'subtitleStyle', 'naturalSpeech', 'replyLanguage']) {
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
    voiceProvider: 12, omniSteps: '16', omniReference: 4, archetypeConversations: 'maybe', storyConversations: 3, storyMissionTalk: 'x', johnnyInHead: 'x',
    johnnyRemarks: 5, companionSpeakUp: 'often', naturalSpeech: 'x', expressiveEmotions: 'x', followUpInterest: 'x', matureContent: 'x', localModel: 'has space',
    multilingualConversations: 'x', vVoice: 'x', vVoiceEngine: 'elevenlabs', enabledByKey: 'all', relationshipModes: 'friends',
    uiLanguage: 'klingon', replyLanguage: 'klingon', keepPreparedVoices: 'always', expressiveEmotionsChosen: 'x', vVoiceChosen: 'x', holocallLiveImageChosen: 'x',
    errorReports: 'off', dynamicInfo: 'all', voiceActivation: 'yes', padTalk: 'yes', keyBindings: 'F7', companionOutfits: 'yes', reachOuts: 'maybe', micDevice: 5,
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

test('Dynamic info: every kind is on unless saved as the boolean false (the mods kind is off unless saved true), unknown kinds are dropped, and what is saved survives a restart', () => {
  const out = run(`${managerLua}
    files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, dynamicInfo: {location: false, time: 'no', company: 0, gear: false, bogus: true, quest: null}}))}
    local manager = newManager()
    local snapshot = manager.snapshot(newPlayer())
    report('info', snapshot.settings.dynamicInfo)
    report('text', settingsText())
    report('flags', convaiDynamicInfo)
    report('mods', manager.dynamicInfo('mods'))
    report('answers', {manager.dynamicInfo('location'), manager.dynamicInfo('time'), manager.dynamicInfo('gear'), manager.dynamicInfo('nothing')})
    -- An apply that turns one more off is saved, and a restart reads it back.
    local ok, problem = manager.applySettings(newPlayer(), {dynamicInfo = {money = false, location = true}})
    report('applied', {ok, problem})
    local again = newManager()
    report('restart', again.snapshot(newPlayer()).settings.dynamicInfo)
    local bad = {manager.applySettings(newPlayer(), {dynamicInfo = {money = 'off'}})}
    report('badValue', {bad[1], bad[2]})
    local unknown = {manager.applySettings(newPlayer(), {dynamicInfo = {bogus = false}})}
    report('badKind', {unknown[1], unknown[2]})
    local notTable = {manager.applySettings(newPlayer(), {dynamicInfo = true})}
    report('badTable', {notTable[1]})
    report('after', settingsText())
    report('phone', snapshot.settings.dynamicInfoPhone)
  `);
  const all = {location: true, time: true, company: true, condition: true, money: true, gear: true, about: true, quest: true, dialogue: true, lastTalk: true, media: true, mods: false};
  assert.deepEqual(out.info, {...all, location: false, gear: false});
  assert.deepEqual(out.phone, PHONE, 'an older file has no phone set: it gets the phone defaults (a caller or texter does not see V), whatever the in-person choices are');
  assert.deepEqual(JSON.parse(out.text).dynamicInfoPhone, PHONE, 'and they are saved, with the marker that they were applied once');
  assert.equal(JSON.parse(out.text).dynamicInfoPhoneDefaults, 1);
  assert.deepEqual(JSON.parse(out.text).dynamicInfo, {...all, location: false, gear: false}, 'the file is rewritten clean');
  assert.deepEqual(out.flags, {...all, location: false, gear: false}, 'the table the per-frame collectors read');
  assert.deepEqual(out.answers.slice(0, 3), [false, true, false]); assert.equal(out.answers[3], true, 'an unknown kind counts as on');
  assert.equal(out.mods, false);
  assert.equal(out.applied[0], true);
  assert.deepEqual(out.restart, {...all, gear: false, money: false}, 'the saved choice survives a restart');
  assert.equal(out.badValue[0], false); assert.equal(out.badKind[0], false); assert.equal(out.badTable[0], false);
  assert.deepEqual(JSON.parse(out.after).dynamicInfo, {...all, gear: false, money: false}, 'a refused batch saves nothing');
});

test('Dynamic info, two sets: the phone set is its own saved table, applied and validated like the in-person one, and the game is read for a kind either set has on', () => {
  const out = run(`${managerLua}
    files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, dynamicInfo: {location: false, gear: false, mods: true}, dynamicInfoPhone: {location: true, time: false, gear: 'no', bogus: true}}))}
    local manager = newManager()
    local snapshot = manager.snapshot(newPlayer())
    report('person', snapshot.settings.dynamicInfo)
    report('phone', snapshot.settings.dynamicInfoPhone)
    report('flags', convaiDynamicInfo)
    -- Location: off in person, on for the phone. Time: on in person, off for the phone. Gear: off in both. Either set on means the game is read.
    report('read', {manager.dynamicInfo('location'), manager.dynamicInfo('time'), manager.dynamicInfo('gear'), manager.dynamicInfo('mods')})
    report('sets', {manager.dynamicInfoSet('location', false), manager.dynamicInfoSet('location', true), manager.dynamicInfoSet('time', false), manager.dynamicInfoSet('time', true)})
    report('text', settingsText())
    local ok = manager.applySettings(newPlayer(), {dynamicInfoPhone = {money = false, gear = true}})
    report('applied', ok)
    local again = newManager()
    local restarted = again.snapshot(newPlayer()).settings
    report('restartPhone', restarted.dynamicInfoPhone)
    report('restartPerson', restarted.dynamicInfo)
    report('flagsAfter', convaiDynamicInfo)
    local bad = {manager.applySettings(newPlayer(), {dynamicInfoPhone = {money = 'off'}})}
    local unknown = {manager.applySettings(newPlayer(), {dynamicInfoPhone = {bogus = false}})}
    local notTable = {manager.applySettings(newPlayer(), {dynamicInfoPhone = true})}
    report('refused', {bad[1], unknown[1], notTable[1]})
    report('after', settingsText())
  `);
  const all = {location: true, time: true, company: true, condition: true, money: true, gear: true, about: true, quest: true, dialogue: true, lastTalk: true, media: true, mods: false};
  assert.deepEqual(out.person, {...all, location: false, gear: false, mods: true});
  assert.deepEqual(out.phone, {...PHONE, location: true, time: false}, 'a phone set of the player\'s own (it differs from the in-person set) keeps its saved booleans; a missing or malformed kind takes the phone default; an unknown kind is dropped');
  assert.deepEqual(JSON.parse(out.text).dynamicInfoPhone, out.phone);
  assert.deepEqual(out.flags, {...all, gear: false, mods: true}, 'the per-frame table: a kind is read when either set has it on');
  assert.deepEqual(out.read, [true, true, false, true]);
  assert.deepEqual(out.sets, [false, true, true, false]);
  assert.equal(out.applied, true);
  assert.deepEqual(out.restartPhone, {...out.phone, money: false, gear: true}); assert.deepEqual(out.restartPerson, out.person, 'the in-person set is untouched');
  assert.equal(out.flagsAfter.gear, true, 'a kind only the phone set wants is still read');
  assert.deepEqual(out.refused, [false, false, false]);
  assert.deepEqual(JSON.parse(out.after).dynamicInfoPhone, out.restartPhone, 'a refused batch saves nothing');
});

test('out-of-range and over-long values are replaced: model ids over 80 characters, a voice volume of 5000, a negative delay', () => {
  const out = run(`${managerLua}
    files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, localModel: 'm'.repeat(81), voiceVolume: 5000, audioDelay: -10, eyeContactHeight: 0.07, voiceProvider: 'POCKET TTS (fast)'}))}
    local snapshot = newManager().snapshot(newPlayer())
    report('settings', snapshot.settings)
  `);
  assert.equal(out.settings.localModel, 'auto');
  assert.equal(out.settings.voiceVolume, 150, 'a voice volume out of range is the default');
  assert.equal(out.settings.vVoiceVolume, 150, 'and V starts from it');
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
  'the removed Multilingual switch on with Pocket TTS and Natural speech': {version: 2, multilingualConversations: true, voiceProvider: 'pocket', naturalSpeech: true},
  'a tag setting beside the Convai cloud voice': {version: 2, voiceProvider: 'convai', naturalSpeech: true, expressiveEmotions: true},
  'the Inworld voice, kept as saved': {version: 2, voiceProvider: 'inworld'},
  'the Inworld voice beside Mature content (read as Pocket)': {version: 2, conversationProvider: 'local', matureContent: true, voiceProvider: 'inworld'},
  'the removed Groq provider': {version: 2, conversationProvider: 'groq'},
  'the first version defaults saved as false': {version: 2, holocallLiveImage: false, vVoice: false},
  'false chosen by the player for those two': {version: 2, holocallLiveImage: false, holocallLiveImageChosen: true, vVoice: false, vVoiceChosen: true},
  'retired keys': {version: 2, followUpQuestions: true, disappearingMessages: true},
  'Companions can see on, and a wrong type': {version: 2, companionVision: true},
  'Companions can see as text': {version: 2, companionVision: 'yes'},
  'Voxtral for V beside Mature content': {version: 2, conversationProvider: 'local', matureContent: true, vVoiceEngine: 'voxtral'},
  'OmniVoice for V beside companions on Pocket (read as Pocket, kept in the file)': {version: 2, voiceProvider: 'pocket', vVoice: true, vVoiceEngine: 'omni'},
  'OmniVoice for V beside companions on OmniVoice': {version: 2, voiceProvider: 'omni', omniSteps: 16, omniReference: 'short', vVoice: true, vVoiceEngine: 'omni'},
  'every removed setting saved off': {version: 2, autoConnectNearby: false, expressiveEmotions: false, expressiveEmotionsChosen: true, gameDialogueContext: false,
    holocallLiveImage: false, holocallLiveImageChosen: true, bodyGestures: false, johnnyHologram: true, vTalks: 'normal'},
  'Johnny’s remarks set while Johnny in your head is off': {version: 2, johnnyInHead: false, johnnyRemarks: 'rare'},
  'Johnny’s remarks beside Johnny in your head': {version: 2, johnnyInHead: true, johnnyRemarks: 'normal'},
  'the reactions saved off by an old default': {version: 2, battleReactions: false, lootReactions: false},
  'the reactions switched off by the player': {version: 2, battleReactions: false, battleReactionsChosen: true, lootReactions: false, lootReactionsChosen: true},
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

test('a saved OmniVoice engine for V survives the load: the snapshot keeps it, the engine in use is OmniVoice only beside companions on OmniVoice (pack taken as installed)', () => {
  for (const [voice, engine] of [['pocket', 'pocket'], ['omni', 'omni'], ['voxtral', 'pocket']]) {
    const out = run(`${managerLua}
      files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, voiceProvider: voice, omniSteps: 16, omniReference: 'short', vVoice: true, vVoiceEngine: 'omni'}))}
      local player = newPlayer()
      local manager = newManager()
      manager.update(player, 0.1)
      report('snapshot', manager.snapshot(player).settings.vVoiceEngine)
      report('engine', manager.vVoiceEngine())
    `);
    assert.equal(out.snapshot, 'omni', `the snapshot keeps the saved engine beside ${voice}`);
    assert.equal(out.engine, engine, `the engine in use beside ${voice}`);
  }
});

test('reading the setting of the moment each frame reads the file once, and again only after a reset; Developer mode is off before the load', () => {
  const out = run(`${managerLua}
    local manager = newManager()
    report('before', manager.developerMode())
    report('beforeReads', (readCounts['runtime/settings.json'] or 0) + (readCounts['runtime/settings.json.previous'] or 0))
    for _ = 1, 500 do
      manager.interfaceLanguage(); manager.developerMode(); manager.battleReactions(); manager.lootReactions(); manager.subtitleStyle()
      manager.naturalSpeech(); manager.vVoice(); manager.vVoiceEngine(); manager.johnnyInHead(); manager.johnnyRemarks()
      manager.storyConversations(); manager.archetypeConversations()
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
    assert.ok((out.provider === 'convai' && out.volume === 150) || (out.provider === 'local' && out.volume === 80), `step ${crash}: ${out.provider} ${out.volume}`);
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

// ---------------------------------------------------------------------------------------------------- settings of 2026-10-20
// Settings the page no longer has, and the ones whose default changed. An old file keeps working: nothing it carries changes a behaviour.
const RETIRED = ['autoConnectNearby', 'expressiveEmotions', 'expressiveEmotionsChosen', 'gameDialogueContext', 'holocallLiveImage',
  'holocallLiveImageChosen', 'bodyGestures', 'johnnyHologram', 'vTalks', 'multilingualConversations', 'followUpInterest'];

// Loads a file text, lets one update save what a load changed, and reports the loaded settings, the written file and the write count.
const loadFile = content => run(`${managerLua}
  files['runtime/settings.json'] = ${luaString(JSON.stringify(content))}
  local player, manager = newPlayer(), newManager()
  manager.update(player, 0.1)
  report('settings', manager.snapshot(player).settings)
  report('writes', writes('runtime/settings.json.tmp'))
  report('text', settingsText())
`);

for (const key of RETIRED) {
  for (const value of key === 'vTalks' ? ['off', 'normal', false, true] : [false, true]) {
    test(`the removed setting ${key} saved as ${JSON.stringify(value)} is dropped from the file once and changes nothing else`, () => {
      const out = loadFile({...freshSettings, [key]: value});
      assert.equal(out.writes, 1, 'one save drops the key');
      assert.equal(JSON.parse(out.text)[key], undefined, `${key} is not in the file any more`);
      assert.equal(out.settings[key], undefined, `${key} is not in the snapshot`);
      assert.deepEqual(JSON.parse(out.text), freshSettings, 'every other setting is as it was');
    });
  }
}

test('a settings.json that still has multilingualConversations: true loads cleanly: the key is dropped and the voice (Pocket included) is left alone', () => {
  for (const provider of ['convai', 'mistral', 'local', 'custom']) {
    const out = loadFile({...freshSettings, conversationProvider: provider, multilingualConversations: true, voiceProvider: 'pocket'});
    const saved = JSON.parse(out.text);
    assert.equal(out.writes, 1, provider + ': one save drops the key');
    assert.equal(saved.multilingualConversations, undefined, provider + ': gone from the file');
    assert.equal(out.settings.multilingualConversations, undefined, provider + ': gone from the snapshot');
    assert.equal(saved.voiceProvider, 'pocket', provider + ': Pocket TTS is kept, not moved to the cloud voice');
    assert.equal(out.settings.voiceProvider, 'pocket');
  }
  const next = loadFile({...freshSettings, multilingualConversations: true, voiceProvider: 'pocket'});
  const again = loadFile(JSON.parse(next.text));
  assert.equal(again.writes, 0, 'a start from the written file writes nothing');
});

test('a settings.json that still has payCharacters (the removed eddies payment) loads cleanly: the key is ignored (unknown keys stay in the file)', () => {
  const out = loadFile({...freshSettings, payCharacters: true});
  assert.equal(out.settings.payCharacters, undefined, 'not in the snapshot');
  assert.equal(out.writes, 0, 'nothing to rewrite');
});

test('the removed settings have no getter any more, and an Apply that still carries one is ignored without an error', () => {
  const out = run(`${managerLua}
    local player, manager = newPlayer(), newManager()
    manager.update(player, 0.1)
    local names = {'autoConnectNearby', 'expressiveEmotions', 'gameDialogueContext', 'holocallLiveImage', 'bodyGestures', 'johnnyHologram', 'vTalks',
      'multilingualConversations', 'followUpInterest'}
    local getters = {}
    for _, name in ipairs({'multilingualActive', 'resolveMultilingualVoice'}) do
      if manager[name] ~= nil then getters[#getters + 1] = name end
    end
    for _, name in ipairs(names) do
      if manager[name] ~= nil then getters[#getters + 1] = name end
    end
    report('getters', getters)
    resetOps()
    local applied = {}
    for _, key in ipairs(names) do
      local ok, refusal = manager.applySettings(player, {[key] = false})
      applied[#applied + 1] = tostring(ok) .. ':' .. tostring(refusal)
    end
    report('applied', applied); report('text', settingsText())
  `);
  assert.deepEqual(out.getters, []);
  assert.ok(out.applied.every(entry => entry === 'true:nil'), JSON.stringify(out.applied));
  assert.deepEqual(JSON.parse(out.text), freshSettings, 'nothing was saved for them');
});

test('Johnny: remarks saved beside Johnny in your head off read as Off and the file is put right; with Johnny on they stay', () => {
  const cases = [
    [{johnnyInHead: false, johnnyRemarks: 'rare'}, {johnnyInHead: false, johnnyRemarks: 'off'}, 1],
    [{johnnyInHead: false, johnnyRemarks: 'normal'}, {johnnyInHead: false, johnnyRemarks: 'off'}, 1],
    [{johnnyInHead: false, johnnyRemarks: 'off'}, {johnnyInHead: false, johnnyRemarks: 'off'}, 0],
    [{johnnyInHead: true, johnnyRemarks: 'rare'}, {johnnyInHead: true, johnnyRemarks: 'rare'}, 0],
    [{johnnyInHead: true, johnnyRemarks: 'normal'}, {johnnyInHead: true, johnnyRemarks: 'normal'}, 0],
    [{johnnyInHead: true, johnnyRemarks: 'medium'}, {johnnyInHead: true, johnnyRemarks: 'medium'}, 0],
    [{johnnyInHead: false, johnnyRemarks: 'medium'}, {johnnyInHead: false, johnnyRemarks: 'off'}, 1],
    [{johnnyInHead: true, johnnyRemarks: 'off'}, {johnnyInHead: true, johnnyRemarks: 'off'}, 0],
    [{johnnyInHead: true, johnnyRemarks: 'loud'}, {johnnyInHead: true, johnnyRemarks: 'off'}, 1],
  ];
  for (const [saved, expected, writeCount] of cases) {
    const out = loadFile({...freshSettings, ...saved});
    const label = JSON.stringify(saved);
    assert.equal(out.settings.johnnyInHead, expected.johnnyInHead, label);
    assert.equal(out.settings.johnnyRemarks, expected.johnnyRemarks, label);
    assert.equal(out.writes, writeCount, label);
    assert.equal(JSON.parse(out.text).johnnyRemarks, expected.johnnyRemarks, label);
  }
});

test('React to battles and to loot: on by default; an unchosen saved false moves to on once, a false the player chose stays; an Apply writes the Chosen flag', () => {
  const fresh = loadFile({...freshSettings});
  assert.equal(fresh.writes, 0);
  assert.deepEqual([fresh.settings.battleReactions, fresh.settings.lootReactions], [true, true]);
  assert.deepEqual([JSON.parse(fresh.text).battleReactionsChosen, JSON.parse(fresh.text).lootReactionsChosen], [false, false]);
  for (const key of ['battleReactions', 'lootReactions']) {
    const chosen = `${key}Chosen`;
    // An unchosen false (no flag, or flag false) is the old default the mod wrote: on, saved once, then stable.
    for (const flag of [undefined, false]) {
      const out = loadFile({...freshSettings, [key]: false, ...(flag === undefined ? {} : {[chosen]: flag})});
      assert.equal(out.settings[key], true, `${key} unchosen false, flag ${flag}`); assert.equal(out.writes, 1, `${key} unchosen false, flag ${flag}`);
      assert.equal(JSON.parse(out.text)[key], true); assert.equal(JSON.parse(out.text)[chosen], false);
    }
    // A false the player chose stays off and nothing is rewritten.
    const kept = loadFile({...freshSettings, [key]: false, [chosen]: true});
    assert.equal(kept.settings[key], false, `${key} chosen false`); assert.equal(kept.writes, 0, `${key} chosen false`);
    // True stays true, flag or not.
    for (const flag of [undefined, false, true]) {
      const out = loadFile({...freshSettings, [key]: true, ...(flag === undefined ? {} : {[chosen]: flag})});
      assert.equal(out.settings[key], true, `${key} true, flag ${flag}`);
    }
    // A file from before the key existed: the default, on, saved once.
    const without = {...freshSettings}; delete without[key];
    const out = loadFile(without);
    assert.equal(out.settings[key], true, `${key}: missing is on`); assert.equal(out.writes, 1);
  }
  // An Apply writes the value and its Chosen flag, for the key it carried only.
  const out = run(`${managerLua}
    local player, manager = newPlayer(), newManager()
    manager.update(player, 0.1)
    assert(manager.applySettings(player, {battleReactions = false}))
    report('text', settingsText())
    local again = newManager()
    report('again', again.snapshot(player).settings)
  `);
  const saved = JSON.parse(out.text);
  assert.deepEqual([saved.battleReactions, saved.battleReactionsChosen, saved.lootReactions, saved.lootReactionsChosen], [false, true, true, false]);
  assert.equal(out.again.battleReactions, false);
  assert.equal(out.again.lootReactions, true);
});


test('a fresh file has the defaults: reactions on, Johnny Off, V’s voice on with Pocket, Natural speech off, no removed key', () => {
  const out = run(`${managerLua}
    local player, manager = newPlayer(), newManager()
    manager.update(player, 0.1)
    report('text', settingsText())
  `);
  const saved = JSON.parse(out.text);
  assert.deepEqual([saved.battleReactions, saved.lootReactions, saved.johnnyInHead, saved.johnnyRemarks, saved.vVoice, saved.vVoiceEngine,
    saved.naturalSpeech, saved.matureContent, saved.conversationProvider],
  [true, true, false, 'off', true, 'pocket', false, false, 'convai']);
  for (const key of RETIRED) assert.equal(saved[key], undefined, key);
});

// Quest memory (decision ledger, witness receipts) is on by default since 2026-10-23. Older files saved false only because that was the
// default, so a file from before defaultsRevision 1 moves to true once; after that a saved false stands.
test('quest memory: an older file with both saved false moves to on once, and a later saved false is kept', () => {
  const out = run(`${managerLua}
    files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, decisionLedger: false, witnessReceipts: false, voice: false}))}
    local first = newManager()
    first.update(newPlayer(), 0.1)
    report('ledger', first.decisionLedger()); report('receipts', first.witnessReceipts())
    report('saved', settingsTable())
    -- A hand edit to false after the move stands, through a restart.
    local edited = settingsTable(); edited.decisionLedger = false
    files['runtime/settings.json'] = json.encode(edited)
    local second = newManager()
    second.update(newPlayer(), 0.1)
    report('ledger2', second.decisionLedger()); report('receipts2', second.witnessReceipts())
    report('revision2', settingsTable().defaultsRevision)
    -- Apply can still turn one off, and it stays off after a restart.
    assert(second.applySettings(newPlayer(), {witnessReceipts = false}))
    local third = newManager()
    report('ledger3', third.decisionLedger()); report('receipts3', third.witnessReceipts())
  `);
  assert.equal(out.ledger, true);
  assert.equal(out.receipts, true);
  assert.equal(out.saved.defaultsRevision, 1);
  assert.equal(out.saved.decisionLedger, true);
  assert.equal(out.saved.witnessReceipts, true);
  assert.equal(out.saved.voice, false, 'other saved values are untouched');
  assert.equal(out.ledger2, false);
  assert.equal(out.receipts2, true);
  assert.equal(out.revision2, 1);
  assert.equal(out.ledger3, false);
  assert.equal(out.receipts3, false);
});

// The phone set (holocalls and Phone Chat texts) is for a character who only hears or reads V: off are what she could not see (location, company and vehicle,
// health and heat and fights, money, gear, music and TV, game dialogue, other mods' state), on are the hour and weather, V's gender and lifepath, the open jobs
// and the time since the last talk (owner, 31 Oct 2026).
const PHONE = {location: false, time: true, company: false, condition: false, money: false, gear: false, about: true, quest: true, dialogue: false, lastTalk: true, media: false, mods: false};

test('Dynamic info, phone defaults: an untouched phone set (missing, empty or the earlier build\'s copy of the in-person set) gets the new defaults once, a set of the player\'s own stays, and the marker stops it', () => {
  const out = run(`${managerLua}
    local function phoneOf(person, phone, marker)
      files['runtime/settings.json'] = json.encode({version = 2, dynamicInfo = person, dynamicInfoPhone = phone, dynamicInfoPhoneDefaults = marker})
      local manager = newManager()
      local settings = manager.snapshot(newPlayer()).settings
      return {phone = settings.dynamicInfoPhone, marker = json.decode(settingsText()).dynamicInfoPhoneDefaults}
    end
    local person = {location = false, gear = false, mods = true}
    -- the earlier build copied the in-person set (every kind) into the phone set on the first load: no choice of the player's
    local copy = {location = false, time = true, company = true, condition = true, money = true, gear = false, about = true, quest = true, dialogue = true, lastTalk = true, media = true, mods = true}
    report('copy', phoneOf(person, copy, nil))
    report('empty', phoneOf(person, {}, nil))
    report('own', phoneOf(person, {location = true, time = false}, nil))
    -- with the marker, even a set equal to the in-person one is the player's: nothing is reset again
    report('marked', phoneOf(person, copy, 1))
    report('markedEmpty', phoneOf(person, {}, 1))
  `);
  assert.deepEqual(out.copy.phone, PHONE, 'the earlier build\'s copy is replaced by the defaults');
  assert.equal(out.copy.marker, 1);
  assert.deepEqual(out.empty.phone, PHONE);
  assert.deepEqual(out.own.phone, {...PHONE, location: true, time: false}, 'a phone set that differs from the in-person set is the player\'s own: its booleans stay, the rest takes the defaults');
  assert.equal(out.own.marker, 1);
  assert.deepEqual(out.marked.phone, {location: false, time: true, company: true, condition: true, money: true, gear: false, about: true, quest: true, dialogue: true, lastTalk: true, media: true, mods: true}, 'with the marker the saved set is left alone');
  assert.deepEqual(out.markedEmpty.phone, PHONE, 'a missing kind takes the phone default');
});

test('Dynamic info: a fresh settings file has the mods kind off and the other eleven on', () => {
  const out = run(`${managerLua}
    local manager = newManager()
    report('info', manager.snapshot(newPlayer()).settings.dynamicInfo)
    report('flags', convaiDynamicInfo)
    report('mods', {manager.dynamicInfo('mods'), manager.dynamicInfo('location')})
    report('text', settingsText())
    report('phone', manager.snapshot(newPlayer()).settings.dynamicInfoPhone)
    files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, dynamicInfo: {mods: 'yes'}}))}
    report('malformed', newManager().snapshot(newPlayer()).settings.dynamicInfo.mods)
  `);
  const expected = {location: true, time: true, company: true, condition: true, money: true, gear: true, about: true, quest: true, dialogue: true, lastTalk: true, media: true, mods: false};
  assert.deepEqual(out.info, expected);
  assert.deepEqual(out.flags, expected);
  assert.deepEqual(out.mods, [false, true]);
  assert.deepEqual(JSON.parse(out.text).dynamicInfo, expected);
  assert.deepEqual(out.phone, PHONE, 'a fresh install: the phone set has its own defaults');
  assert.deepEqual(JSON.parse(out.text).dynamicInfoPhone, PHONE);
  assert.equal(out.malformed, false);
});

// Default key bindings (0.3.4): the five actions that have a default get it once, a key another action holds is not taken, a key cleared later stays cleared.
const defaultKeys = {manager: 'IK_F4', text: 'IK_F6', voice: 'IK_F7', group_text: 'IK_F8', group_voice: 'IK_F10'};
const withoutKeys = () => { const {keyBindings, keyDefaultsGiven, ...rest} = freshSettings; return rest; };

test('default keys: an old file without keyDefaultsGiven is rewritten once with the five defaults; the next start writes nothing', () => {
  const first = loadFile(withoutKeys());
  assert.equal(first.writes, 1);
  assert.deepEqual(first.settings.keyBindings, defaultKeys);
  assert.deepEqual(JSON.parse(first.text).keyBindings, defaultKeys);
  assert.equal(JSON.parse(first.text).keyDefaultsGiven, true);
  assert.deepEqual(JSON.parse(first.text), freshSettings);
  const second = loadFile(JSON.parse(first.text));
  assert.equal(second.writes, 0, 'a file that has had its defaults is not rewritten');
});

test('default keys: a key the player set is kept, a key another action holds is skipped, the Johnny actions get none', () => {
  const kept = loadFile({...withoutKeys(), keyBindings: {voice: 'IK_F2'}});
  assert.deepEqual(kept.settings.keyBindings, {...defaultKeys, voice: 'IK_F2'});
  // text already holds F7, so the default of voice (F7) is skipped; the others still get theirs.
  const taken = loadFile({...withoutKeys(), keyBindings: {text: 'IK_F7'}});
  assert.deepEqual(taken.settings.keyBindings, {manager: 'IK_F4', text: 'IK_F7', group_text: 'IK_F8', group_voice: 'IK_F10'});
  assert.equal(taken.settings.keyBindings.johnny_voice, undefined);
  assert.equal(taken.settings.keyBindings.johnny_text, undefined);
});

test('default keys: a key cleared after the defaults were given stays cleared through a restart, and Restore defaults puts the defaults back', () => {
  const out = run(`${managerLua}
    local player, manager = newPlayer(), newManager()
    manager.update(player, 0.1)
    assert(manager.setKeyBinding(player, 'voice', nil))
    local again = newManager()
    report('cleared', again.keyBindings())
    report('batch', manager.defaultKeyBindings())
    assert(manager.applySettings(player, {keyBindings = manager.defaultKeyBindings()}))
    report('restored', newManager().keyBindings())
  `);
  assert.deepEqual(out.cleared, {manager: 'IK_F4', text: 'IK_F6', group_text: 'IK_F8', group_voice: 'IK_F10'});
  assert.deepEqual(out.batch, {...defaultKeys, johnny_voice: false, johnny_text: false});
  assert.deepEqual(out.restored, defaultKeys);
});

test('the Controller talk button is gone: a saved padTalk true becomes the left stick click on Talk by voice, quietly, and the key leaves the file', () => {
  const on = loadFile({...withoutKeys(), padTalk: true});
  assert.equal(on.settings.padTalk, undefined);
  assert.equal(JSON.parse(on.text).padTalk, undefined);
  assert.deepEqual(on.settings.keyBindings, {...defaultKeys, voice: 'IK_Pad_LeftThumb'});
  // padTalk false (the old default) only drops the key.
  const off = loadFile({...freshSettings, padTalk: false});
  assert.equal(off.writes, 1);
  assert.equal(JSON.parse(off.text).padTalk, undefined);
  assert.deepEqual(off.settings.keyBindings, defaultKeys);
  // A voice key the player already set is not replaced, and a click another action holds is not taken twice.
  const set = loadFile({...withoutKeys(), padTalk: true, keyBindings: {voice: 'IK_F2'}});
  assert.equal(set.settings.keyBindings.voice, 'IK_F2');
  const held = loadFile({...withoutKeys(), padTalk: true, keyBindings: {text: 'IK_Pad_LeftThumb'}});
  assert.equal(held.settings.keyBindings.text, 'IK_Pad_LeftThumb');
  assert.notEqual(held.settings.keyBindings.voice, 'IK_Pad_LeftThumb');
  assert.equal(JSON.parse(held.text).padTalk, undefined);
});

test('V’s microphone voice is its own setting: a file without vVoiceMicOwn and typed lines Off loses the microphone setting once, with the marker nothing is forced', () => {
  const old = loadFile((({vVoiceMicOwn, ...rest}) => rest)({...freshSettings, vVoice: false, vVoiceChosen: true, vVoiceMic: true}));
  assert.equal(old.settings.vVoiceMic, false, 'what the player used to hear');
  assert.equal(old.writes, 1);
  assert.equal(JSON.parse(old.text).vVoiceMicOwn, true);
  const typedOn = loadFile((({vVoiceMicOwn, ...rest}) => rest)({...freshSettings, vVoice: true, vVoiceMic: true}));
  assert.equal(typedOn.settings.vVoiceMic, true, 'typed lines on: nothing to correct');
  assert.equal(typedOn.writes, 1, 'the marker is saved');
  const own = loadFile({...freshSettings, vVoice: false, vVoiceChosen: true, vVoiceMic: true, vVoiceMicOwn: true});
  assert.equal(own.settings.vVoiceMic, true, 'with the marker, microphone on beside typed Off stands');
  assert.equal(own.settings.vVoice, false);
  assert.equal(own.writes, 0);
});

test('Characters text first is off by default (30 Oct), and a player who turned it on keeps it across a restart', () => {
  const out = run(`${managerLua}
    -- Story packs are not part of 0.4.0 (docs/STORY_PACKS_INACTIVE.md): this runs with the development switch on, bridge/story-packs-off.test.mjs has the release build.
    files['runtime/story-packs-dev.flag'] = ''
    local fresh = newManager()
    report('freshOff', fresh.reachOuts()); report('freshSnapshot', fresh.snapshot(newPlayer()).settings.reachOuts)
    files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, reachOuts: true}))}
    local saved = newManager()
    report('savedOn', saved.reachOuts()); report('savedSnapshot', saved.snapshot(newPlayer()).settings.reachOuts)
    saved.update(newPlayer(), 0.1)
    report('kept', settingsText())
    files['runtime/settings.json'] = ${luaString(JSON.stringify({version: 2, reachOuts: false}))}
    report('savedOff', newManager().reachOuts())
  `);
  assert.equal(out.freshOff, false); assert.equal(out.freshSnapshot, false);
  assert.equal(out.savedOn, true); assert.equal(out.savedSnapshot, true);
  assert.equal(JSON.parse(out.kept).reachOuts, true);
  assert.equal(out.savedOff, false);
});
