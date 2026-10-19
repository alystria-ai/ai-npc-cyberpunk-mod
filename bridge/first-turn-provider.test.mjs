// Local AI saved as the conversation provider, and the first turn after a load showed the Convai daily limit (2026-10-19 report, 0.2.1,
// RTX 5070 Ti, Local AI and Mature packs). The cause: a Local AI that could not start (here, for want of free graphics memory) handed every turn
// to Convai, also when Convai's free tier had used today's turns; each turn then met the daily limit, the notice told the player to try the Local
// AI they had chosen, and later turns were silent (that notice shows once a session) after "Preparing connection to …" (the game reads Convai
// as the provider). Still so on main before this change: the reordered settings poll (fixes-0.2.2) only fixed which model the first start loads.
//
// Now: Convai takes a Local AI's turns only while it can answer them; otherwise they stay on Local AI and fail with its own reason
// ('local-no-memory', 'local-unavailable'), and a new model choice tries the start again. The status file is not written before the first
// settings poll, so the game never reads the default provider as the saved one.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, createHmac} from 'node:crypto';
import {hostname, userInfo} from 'node:os';
import {MistralProvider, MistralControl} from './mistral-key.mjs';
import {dayOf} from './shared-key-guard.mjs';
import {launchBridge} from './bridge-run-fixture.mjs';

// The fake Mistral key of bridge/startup-saved-choices.test.mjs (never a real one).
const MISTRAL_KEY = 'mistralFixtureKey0123456789abcdefgh';
async function provider({key = null} = {}) {
  const value = new MistralProvider({keyPath: 'k.txt', readText: async () => { if (key === null) throw Error('ENOENT'); return `api-key=${key}`; },
    writeText: async () => {}, removeFile: async () => {}});
  return value.load();
}

test('Local AI down with no Mistral key: Convai takes its turns only while Convai can answer; with its free day used up they stay on Local AI', async () => {
  const p = await provider();
  let convaiOpen = true;
  p.convaiAvailable = () => convaiOpen;
  p.setPreference('local'); p.apply();
  p.noteLocalFailure('low-memory');
  assert.equal(p.requested, 'convai', 'Convai can answer: the designed fallback, with one notice');
  assert.equal(p.localDown, false);
  p.apply();
  assert.equal(p.route, 'convai');
  assert.equal(p.takeNotice(), 'local-fallback');

  // Convai's day runs out: the turns go back to Local AI at the next idle boundary, and nothing claims a cloud provider answers.
  convaiOpen = false;
  assert.equal(p.requested, 'local');
  assert.equal(p.pending, true);
  assert.equal(p.localDown, true);
  p.apply();
  assert.equal(p.route, 'local');
  assert.equal(p.pending, false);
  assert.equal(p.localFailureCode, 'local-no-memory');
  assert.equal(p.takeNotice(), undefined);

  // A new day (or a raised limit): Convai takes over again.
  convaiOpen = true;
  assert.equal(p.requested, 'convai');
  assert.equal(p.localDown, false);
});

test('Local AI that cannot start while Convai\'s day is already used: the turns never leave Local AI, and the reason picks the code', async () => {
  const p = await provider();
  p.convaiAvailable = () => false;
  p.setPreference('local'); p.apply();
  p.noteLocalFailure('start-failed');
  assert.equal(p.requested, 'local');
  assert.equal(p.pending, false, 'no switch at all');
  assert.equal(p.active, true, 'a text provider still answers: no Convai connection is prepared (the game shows no "Preparing connection")');
  assert.equal(p.localDown, true);
  assert.equal(p.localFailureCode, 'local-unavailable');
  assert.equal(p.takeNotice(), undefined, 'the local-fallback notice would say a cloud provider is used');
  // A Mistral key changes nothing here: Mistral takes over as before.
  const keyed = await provider({key: MISTRAL_KEY});
  keyed.convaiAvailable = () => false;
  keyed.setPreference('local'); keyed.apply(); keyed.noteLocalFailure('low-memory');
  assert.equal(keyed.requested, 'mistral');
  assert.equal(keyed.localDown, false);
  // An observer that throws counts as "Convai can answer" (the old behaviour), never as a crash.
  const broken = await provider();
  broken.convaiAvailable = () => { throw Error('guard gone'); };
  broken.setPreference('local'); broken.apply(); broken.noteLocalFailure('low-memory');
  assert.equal(broken.requested, 'convai');
});

test('failureCode: a failed turn names Local AI\'s problem while Local AI is chosen and down, and leaves every other code alone', async () => {
  const p = await provider();
  let convaiOpen = false;
  p.convaiAvailable = () => convaiOpen;
  assert.equal(p.failureCode('daily-limit'), 'daily-limit', 'Convai chosen: its limit is the right notice');
  assert.equal(p.failureCode('local-fallback'), 'local-fallback');
  p.setPreference('local'); p.apply();
  assert.equal(p.failureCode('daily-limit'), 'daily-limit', 'Local AI works: nothing to correct');
  p.noteLocalFailure('low-memory');
  assert.equal(p.failureCode('local-fallback'), 'local-no-memory', 'nobody takes over: not "so a cloud provider is used"');
  assert.equal(p.failureCode('daily-limit'), 'local-no-memory', 'never "try Local AI" to a player who chose it');
  for (const code of [undefined, 'local-failed', 'mistral-key', 'custom-unreachable', 'quota-shared']) assert.equal(p.failureCode(code), code, String(code));
  convaiOpen = true;
  assert.equal(p.failureCode('local-fallback'), 'local-fallback', 'Convai takes the next turns: the fallback notice is true');
  assert.equal(p.failureCode('daily-limit'), 'local-no-memory', 'a turn that fell back to Convai and met its limit still names Local AI');
  const other = await provider();
  other.setPreference('local'); other.apply(); other.convaiAvailable = () => false; other.noteLocalFailure('crashed');
  assert.equal(other.failureCode('local-fallback'), 'local-unavailable');
});

test('the status file is held while the provider says so: open() and every publish write nothing, the first one after the release writes the applied provider', async () => {
  const p = await provider();
  p.statusHeld = true;
  const published = [];
  const control = new MistralControl({provider: p, commandPath: 'cmd.json', model: 'm', publish: async value => published.push(value), read: async () => ''});
  await control.open();
  p.setPreference('local'); p.apply();
  await control.publishStatus();
  assert.deepEqual(published, [], 'nothing before the first settings poll is done');
  p.statusHeld = false;
  await control.publishStatus();
  assert.equal(published.length, 1);
  assert.deepEqual({provider: published[0].provider, effective: published[0].effective}, {provider: 'local', effective: 'local'});
  // A provider object without the flag (the tests' fakes, an add-on's) publishes as before.
  const plain = []; await new MistralControl({provider: {preference: 'convai', applied: 'convai'}, commandPath: 'c', publish: async value => plain.push(value), read: async () => ''}).open();
  assert.equal(plain.length, 1);
});

// The wiring in the bridge script (a script, not a module: its source is read).
const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
test('the bridge wires it: the shared key\'s day decides convaiAvailable, every failed turn and phone message is corrected, the status is held until the first poll and each turn is named', () => {
  assert.match(bridge, /const convaiDayUsed = \(\) => \{\n\s*if \(keys\.source !== 'shared'\) return false;\n\s*if \(turnGuard\.snapshot\(\)\?\.blocked === true\) return true;\n\s*try \{ keys\.assertAllowed\(\); return false; \} catch \{ return true; \}\n\};\nmistral\.convaiAvailable = \(\) => !convaiDayUsed\(\);/);
  assert.equal((bridge.match(/\.\.\.keyFailure\(/g) ?? []).length, 0, 'a failed-turn reply skips the correction');
  assert.equal((bridge.match(/\.\.\.turnFailure\(error, input\)/g) ?? []).length, 3, 'the text, streamed and voice failures');
  assert.match(bridge, /failureCode: error => \{ const code = mistralCodeFor\(error\) \?\? quota\.codeFor\(error\); return providerFailureCode\(/);
  assert.match(bridge, /const providerFailureCode = code => mistral\.failureCode\(code\);/);
  // Held from construction until the first poll, released before the bridge says it is ready.
  const created = bridge.indexOf('const mistral = await new MistralProvider('), held = bridge.indexOf('mistral.statusHeld = true;');
  const firstPoll = bridge.indexOf('\nawait pollSettings(false);'), released = bridge.indexOf('mistral.statusHeld = false;\nawait mistralControl.publishStatus()');
  const ready = bridge.indexOf("console.log('[CyberpunkConvai] Convai conversation bridge ready')");
  assert.ok(created > 0 && held > created && held - created < 700, 'held right after construction');
  assert.ok(firstPoll > held && released > firstPoll && released - firstPoll < 400 && ready > released, 'released right after the first poll, before ready');
  // The turn the 'thinking' status is for, and the provider that took it (mod/service-status.lua noReplyMessage reads them at the 90 s timeout).
  assert.match(bridge, /void status\('thinking', profile\.name, \{requestId: input\.requestId, provider: mistral\.active \? mistral\.route : 'convai'\}\)/);
  assert.match(bridge, /void status\('thinking', profile\.name, \{requestId: input\.requestId, provider: route\}\)/);
  assert.equal((bridge.match(/await status\('ready', profile\.name, \{requestId: input\.requestId\}\);/g) ?? []).length, 2);
  // A held group look-ahead turn the game submits is named too (it never passes runInput's 'thinking').
  assert.match(bridge, /active = held; void cancelMicrophone\(\);\n(\s*\/\/[^\n]*\n)\s*void status\('thinking', profileFor\(input, roster\)\?\.name \?\? '', \{requestId: input\.requestId, provider: mistral\.active \? mistral\.route : 'convai'\}\)/);
  // A new model choice tries a failed start again (the notice tells the player to pick a smaller model).
  assert.match(bridge, /else if \(!first && RETRY_ON_CHOICE\.has\(mistral\.localBroken\) && mistral\.clearLocalFailure\(mistral\.localBroken\)\) prepareLocal\(\);/);
});

// ---- A real bridge process (bridge/bridge-run-fixture.mjs) -----------------------------------------------------------------------------

const FAKE_SERVER = 'llama/llama-server.exe';
const standardPack = {
  'manifest.json': JSON.stringify({version: 1, server: FAKE_SERVER,
    standard: {file: 'models/standard.gguf', name: 'Qwen3.5-4B'}, lite: {file: 'models/lite.gguf', name: 'Bonsai-2-4B'}}),
  [FAKE_SERVER]: 'fake server',
  'models/standard.gguf': 'x'.repeat(4000), 'models/lite.gguf': 'x'.repeat(2000),
};
// A card whose free memory no model fits beside its headroom: the start fails with 'low-memory' (the game holding the graphics memory).
const FULL_CARD = 'Available devices:\n  Vulkan0: AMD Radeon Test Card (8000 MiB, 10 MiB free)\n';
const status = bridge => bridge.read('mistral-state.json');
const listings = async bridge => (await bridge.llama()).filter(event => event.event === 'list-devices').length;
// The shared key's count, signed the way the bridge checks it (bridge/shared-key-guard.mjs UsageStore). Its machine id is the host and user
// names here: the side-effect guard refuses the registry lookup of the Windows machine GUID (logged as one forbidden execFile per store).
function usedUpToday(limit) {
  const machine = `${hostname()}|${userInfo().username}`, now = Date.now();
  const body = {v: 1, day: dayOf(now), count: limit, seen: now};
  const secret = createHash('sha256').update(`cyberpunk-convai/usage/v1|${machine}`).digest();
  const mac = createHmac('sha256', secret).update(`${body.v}|${body.day}|${body.count}|${body.seen}`).digest('hex');
  return JSON.stringify({...body, mac}) + '\n';
}

test('a real bridge whose Local AI cannot start for want of graphics memory, with Convai\'s free turns left: Convai answers meanwhile, as designed', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', voice: false}, localAi: standardPack, fakeLlama: FAKE_SERVER,
    env: {CYBERPUNK_TEST_DEVICES: FULL_CARD}});
  try {
    await bridge.ready();
    const settled = await bridge.until(() => status(bridge), value => value?.localAi === 'no-memory' && value.pending === false, 'the failed start was not reported');
    assert.deepEqual({provider: settled.provider, effective: settled.effective}, {provider: 'local', effective: 'convai'});
    assert.doesNotMatch(bridge.errors(), /turns stay on Local AI/);
  } finally { await bridge.cleanup(); }
});

test('the same bridge with the shared key\'s day used up: the turns stay on Local AI, which says why, and choosing another model tries the start again', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', voice: false}, localAi: standardPack, fakeLlama: FAKE_SERVER,
    stateFiles: {'daily-usage.json': usedUpToday(1)},
    env: {CYBERPUNK_TEST_DEVICES: FULL_CARD, CYBERPUNK_CONVAI_DAILY_LIMIT: '1', LOCALAPPDATA: folder => `${folder}\\appdata`}});
  try {
    await bridge.ready();
    assert.match(bridge.errors(), /Shared conversation allowance: 1 turns a day, 0 left today/);
    const settled = await bridge.until(() => status(bridge), value => value?.localAi === 'no-memory', 'the failed start was not reported');
    await bridge.idle(1200);   // two polls: a switch to Convai would have been applied by now
    const after = await status(bridge);
    assert.deepEqual({provider: after.provider, effective: after.effective, pending: after.pending}, {provider: 'local', effective: 'local', pending: false},
      `Local AI keeps the turns (main sent them to Convai, where each met the daily limit)\n${bridge.errors()}`);
    assert.equal(settled.provider, 'local');
    assert.doesNotMatch(bridge.errors(), /Conversation provider: convai/);
    assert.match(bridge.errors(), /\[LocalAI\] Local AI is unavailable \(low-memory\) and Convai's free turns for today are used: turns stay on Local AI/);
    const own = await bridge.read('own-key-state.json');
    assert.equal(own?.daily?.blocked, true, 'the settings page says the free tier is used up');

    // The notice tells the player to pick a smaller model: a new choice tries the start again (the fake card still has no room).
    const before = await listings(bridge);
    await bridge.writeSettings({conversationProvider: 'local', voice: false, localModel: 'lite'});
    await bridge.until(() => listings(bridge), count => count > before, 'the new model choice did not try the start again', 15000);
    assert.match(bridge.errors(), /\[LocalAI\] model choice is now lite/);
    // Only the refused registry lookups of the machine id (the guard's own refusal), nothing that leaves the machine.
    assert.deepEqual((await bridge.forbidden()).filter(line => line !== 'execFile'), []);
  } finally { await bridge.cleanup(); }
});
