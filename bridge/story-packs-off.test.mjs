// Story packs are not part of release 0.4.0 (owner decision 31 Oct 2026, docs/STORY_PACKS_INACTIVE.md). These tests pin the one switch: off by default in a release
// build, a saved "on" stays off, no row in Settings, nothing built or written on either side, and the development switch turns it all back on.
// This file must NOT import bridge/story-packs-dev-on.mjs: it proves the default.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configureStoryPacksGate, resetStoryPacksGate, storyPacksAvailable, STORY_PACKS_ENV, STORY_PACKS_FLAG} from './story-packs-gate.mjs';
import {parseBonds} from './bonds.mjs';
import {BondPacks} from './bond-pack-runner.mjs';
import {nsuiHarness, run} from './manager-fixture.mjs';
import {run as runStartup, managerLua} from './startup-lua-fixture.mjs';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const BLOCK = {version: 1, on: true, copy: 'party', packs: true, reach: true, invitations: true, eddies: true, romance: 'together'};

test('the bridge gate is off without the flag file and the environment variable, and each of the two turns it on', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'story-gate-'));
  try {
    delete process.env[STORY_PACKS_ENV];
    resetStoryPacksGate();
    assert.equal(storyPacksAvailable(), false, 'nothing configured');
    configureStoryPacksGate({runtime: folder, env: {}});
    assert.equal(storyPacksAvailable(), false, 'an empty runtime folder');
    writeFileSync(path.join(folder, STORY_PACKS_FLAG), '');
    assert.equal(storyPacksAvailable(), false, 'the answer is found once and kept: no polling');
    configureStoryPacksGate({runtime: folder, env: {}});
    assert.equal(storyPacksAvailable(), true, 'the flag file');
    rmSync(path.join(folder, STORY_PACKS_FLAG));
    configureStoryPacksGate({runtime: folder, env: {[STORY_PACKS_ENV]: '1'}});
    assert.equal(storyPacksAvailable(), true, 'the environment variable');
    configureStoryPacksGate({runtime: folder, env: {[STORY_PACKS_ENV]: '0'}});
    assert.equal(storyPacksAvailable(), false, 'only 1 turns it on');
  } finally {
    rmSync(folder, {recursive: true, force: true});
    resetStoryPacksGate();
  }
});

test('in a release build a request that says packs and reach is read without them, and the other flags of the bonds block are kept', () => {
  delete process.env[STORY_PACKS_ENV];
  resetStoryPacksGate();
  const block = parseBonds(BLOCK);
  assert.equal(block.packs, undefined, 'a saved On does not start the packs');
  assert.equal(block.reach, undefined, 'and not the reach-outs');
  assert.deepEqual(block, {on: true, copy: 'party', invitations: true, eddies: true, romance: 'together'}, 'bonds, invitations, eddies and romance work as before');
  // With the development switch on, the same block keeps both flags.
  process.env[STORY_PACKS_ENV] = '1';
  resetStoryPacksGate();
  try {
    assert.equal(parseBonds(BLOCK).packs, true);
    assert.equal(parseBonds(BLOCK).reach, true);
  } finally {
    delete process.env[STORY_PACKS_ENV];
    resetStoryPacksGate();
  }
});

test('the runner the bridge builds without the switch is inert: it reads and writes no file, starts nothing, has nothing for the game and runs no timer', async () => {
  const touched = [];
  const timers = [];
  const runner = new BondPacks({characters: new Set(['panam-palmer']), packs: [], reach: null, path: null, effectsPath: null,
    read: file => { touched.push(['read', file]); return Promise.reject(new Error('no')); },
    write: file => { touched.push(['write', file]); return Promise.resolve(true); },
    timers: {set: fn => { timers.push(fn); return {unref() {}}; }, clear() {}}, debounceMs: 0});
  assert.equal(await runner.load(), 0, 'no state file is read');
  const input = {requestId: 'r1', profileKey: 'panam-palmer', name: 'Panam', text: 'hey', turnContext: {gameTime: 100000}, bonds: {on: true, copy: 'party'}};
  runner.on = false;
  assert.equal(runner.forTurn(input, {level: 9}), null, 'no pack decision, no stage note, no pack line');
  runner.afterTurn(input, 'hello', null);
  assert.equal(runner.noteMeeting('panam-palmer', 'met', 100000), null);
  assert.equal(runner.questActive(), false, 'the quest poll never has a reason to run');
  assert.equal(runner.reachWanted(), false, 'no reach-out is wanted');
  assert.deepEqual(runner.playState().quests, [], 'no quest for the game');
  assert.equal(runner.playState().reach.enabled, false);
  assert.deepEqual(runner.playState().reach.items, []);
  assert.deepEqual(runner.source().active(), {}, 'no pack is listed on the Relationships page');
  assert.equal(runner.lineFor('panam-sunset-coffee', 'P1.walk.02'), null, 'no scripted line');
  assert.equal(runner.forgetHistory({all: true}), 0);
  await runner.flush();
  assert.deepEqual(touched, [], 'no file was read or written (an existing bond-packs.json is left alone)');
  assert.equal(timers.length, 0, 'no timer');
});

test('convai-bridge builds the runner inert without the switch, never syncs the play file, writes no gift list and starts no quest timer', () => {
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /configureStoryPacksGate\(\{runtime\}\);\nconst storyPacksOn = storyPacksAvailable\(\);/);
  assert.match(bridge, /\{path: resolve\(stateDirectory, 'bond-packs\.json'\), effectsPath: resolve\(runtime, 'bond-effects\.json'\)\} : \{packs: \[\], reach: null, path: null, effectsPath: null\}/);
  assert.match(bridge, /if \(storyPacksOn\) void syncAllowlist\(/);
  assert.match(bridge, /const questSync = storyPacksOn \? \(\) => \{ void questPoller\.sync\(\); \} : \(\) => \{\};/);
  // The poller starts its timer only from sync(): nothing else calls it.
  assert.equal([...bridge.matchAll(/questPoller\.sync\(/g)].length, 1, 'the only caller of the quest poller sync is the gated questSync');
  assert.match(read('./bonds.mjs'), /const packsMay = storyPacksAvailable\(\);/);
});

test('the shipped bridge list names the gate module', () => {
  assert.match(read('../packaging/runtime-layout.mjs'), /'bridge\/story-packs-gate\.mjs'/);
});

// ---- the game side -----------------------------------------------------------------------------------------------------------------------------------------

const settingsFile = {version: 2, characterBonds: true, storyPacks: true, reachOuts: true};
const luaString = text => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

test('manager: a saved On for Story packs and Characters text first reads as off without the switch, the snapshot says so, and the saved values stay in the file', () => {
  const report = runStartup(`${managerLua}
    files['runtime/settings.json'] = ${luaString(JSON.stringify(settingsFile))}
    local manager = newManager()
    local player = newPlayer()
    local before = manager.snapshot(player).settings
    report('before', {packs = manager.storyPacks(), reach = manager.reachOuts(), available = manager.storyPacksAvailable(), snapPacks = before.storyPacks,
      snapReach = before.reachOuts, snapAvailable = before.storyPacksAvailable, bonds = manager.characterBonds()})
    manager.update(player, 0.1)
    report('file', json.decode(settingsText()))
    -- The development switch is the file runtime/story-packs-dev.flag, looked for again after a refresh.
    files['runtime/story-packs-dev.flag'] = ''
    assert(manager.storyPacksAvailable() == false, 'looked for once: no polling')
    manager.refreshStoryPacksGate()
    report('after', {packs = manager.storyPacks(), reach = manager.reachOuts(), available = manager.storyPacksAvailable(), snapPacks = manager.snapshot(player).settings.storyPacks})
  `);
  assert.deepEqual(report.before, {packs: false, reach: false, available: false, snapPacks: false, snapReach: false, snapAvailable: false, bonds: true});
  assert.equal(report.file.storyPacks, true, 'the saved value is left alone');
  assert.equal(report.file.reachOuts, true);
  assert.deepEqual(report.after, {packs: true, reach: true, available: true, snapPacks: true}, 'with the switch the saved values count again');
});

test('manager: Story packs is off by default for a new player, with or without the switch', () => {
  const report = runStartup(`${managerLua}
    local manager = newManager()
    local player = newPlayer()
    manager.snapshot(player)
    report('plain', {packs = manager.storyPacks(), reach = manager.reachOuts()})
    manager.update(player, 0.1)
    files['runtime/story-packs-dev.flag'] = ''
    manager.refreshStoryPacksGate()
    report('dev', {packs = manager.storyPacks(), reach = manager.reachOuts(), saved = json.decode(settingsText())})
  `);
  assert.deepEqual(report.plain, {packs: false, reach: false});
  assert.equal(report.dev.packs, false);
  assert.equal(report.dev.reach, false);
  assert.equal(report.dev.saved.storyPacks, false);
  assert.equal(report.dev.saved.reachOuts, false);
});

// The Settings page fixture of the manager tests, with the development switch file (the fixture has it) removed or kept.
const companionRows = flag => `${nsuiHarness()}
  ${flag ? '' : "files['runtime/story-packs-dev.flag'] = nil"}
  manager.refreshStoryPacksGate()
  assert(manager.applySettings(player, {characterBonds = true, storyPacks = true, reachOuts = true}))
  assert(invoke('tab:settings').ok)
  assert(invoke('settings:companions').ok and managerUi.inspect().view == 'settings-companions')
  local ids = {}
  for _, section in ipairs(loaded.categories) do
    if section.id ~= 'navigation' then for _, item in ipairs(section.settings) do ids[#ids + 1] = item.id end end
  end
  local list = table.concat(ids, ',')
`;

test('Settings > Companions has no Story packs and no Characters text first row without the switch, even with both saved on, and Character bonds stays', () => {
  run(`${companionRows(false)}
    assert(list == 'immersive-invitations,housemates,companionOutfits,characterEddies,characterBonds,companionReactions', list)
    assert(manager.storyPacks() == false and manager.reachOuts() == false and manager.characterBonds() == true)
    -- Another way to the setting changes nothing: the value is accepted and kept, and still reads as off.
    assert(manager.applySettings(player, {storyPacks = true}))
    assert(manager.storyPacks() == false)
  `);
});

test('with the switch on the two rows are back, between Character bonds and Companions react', () => {
  run(`${companionRows(true)}
    assert(list == 'immersive-invitations,housemates,companionOutfits,characterEddies,characterBonds,storyPacks,reachOuts,companionReactions', list)
    assert(manager.storyPacks() == true and manager.reachOuts() == true)
  `);
});

test('the Relationships page shows no stories and no "No story yet" line without the switch, though the bond details stay', () => {
  run(`${companionRows(false)}
    convaiBondsList = function() return {{name = 'Judy Alvarez', level = 5, title = 'Good friend', points = 262, next = 350, warm = 120,
      story = 150, talk = 112, arcDone = 6, arcTotal = 9, lastAt = os.time() * 1000.0, packs = {{title = 'Dressed for Dinner', state = 'active', label = 'x'}}}} end
    core.setView('bonds')
    local rows = {}
    for _, section in ipairs(core.model().categories) do for _, item in ipairs(section.settings) do rows[item.id] = item end end
    assert(rows['bond:1'] and rows['bond:1'].value == 'Level 5', 'the bond is listed')
    assert(rows['bond:1'].description:find('Their quests: 6 of 9 finished', 1, true), 'the character quests of the game stay')
    assert(not rows['bond:1:pack:1'], 'no story row')
    assert(not rows['bond:1'].description:find('No story yet', 1, true))
  `);
});

test('init.lua asks the manager for both halves, so the one gate covers the bonds block, the car decision, the quest build and the reach-outs', () => {
  const init = read('../mod/init.lua');
  assert.match(init, /storyPacks = function\(\) return type\(manager\.storyPacks\) == 'function' and manager\.storyPacks\(\) end,/);
  assert.match(init, /reach = function\(\) return type\(manager\.reachOuts\) == 'function' and manager\.reachOuts\(\) end,/);
  assert.match(init, /return type\(manager\.characterBonds\) == 'function' and manager\.characterBonds\(\) == true\n\s+and type\(manager\.storyPacks\) == 'function' and manager\.storyPacks\(\) == true/);
  // The tick runs the quest system only when it exists or the world is new: once per world with the packs off, a nil check afterwards.
  assert.match(init, /if \(convaiQuestPlay or convaiQuestDue\) and worldReady then convaiQuestTick\(player, elapsedPoll\) end/);
  const manager = read('../mod/manager.lua');
  assert.match(manager, /pcall\(io\.open, 'runtime\/story-packs-dev\.flag', 'rb'\)/);
});
