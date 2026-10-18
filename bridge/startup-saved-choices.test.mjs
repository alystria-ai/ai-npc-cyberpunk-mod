// What the first settings poll does with the saved choices (key, provider), and what every later poll does when the settings file is
// empty, half written, garbage or missing for an instant. A real bridge process (bridge/bridge-run-fixture.mjs).
//
// The game's Lua rewrites runtime/settings.json IN PLACE (open for writing, then fill), so a poll can read it empty or cut short; after the
// MO2 install every exchange file also ships as an empty placeholder. Such a read must mean "nothing yet", never "the defaults", or a saved choice
// would be reset for half a second (and the Convai key, the provider and every open connection with it).
import {test, describe, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {launchBridge} from './bridge-run-fixture.mjs';

const OWN_KEY = 'player-fixture-convai-key-0123456789abcdef';
const MISTRAL_KEY = 'mistralFixtureKey0123456789abcdefgh';
const SHARED_KEY = 'isolated-test-key-not-a-real-credential';

// The saved key and provider are both in force by the time the bridge says it is ready, the key first, and neither leaves the machine except
// the provider's own warm-up request.
test('saved Convai-key and Mistral choices are applied (key first) before the bridge is ready; the keys appear nowhere and only api.mistral.ai is contacted', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {useOwnConvaiKey: true, conversationProvider: 'mistral', voice: false},
    stateFiles: {'player-convai-key.txt': `api-key=${OWN_KEY}\n`, 'player-mistral-key.txt': `api-key=${MISTRAL_KEY}\n`}});
  try {
    await bridge.ready();
    const own = await bridge.read('own-key-state.json');
    assert.deepEqual({preference: own.preference, saved: own.saved, active: own.active, pending: own.pending, tail: own.tail},
      {preference: true, saved: true, active: 'player', pending: false, tail: OWN_KEY.slice(-4)});
    const provider = await bridge.read('mistral-state.json');
    assert.deepEqual({provider: provider.provider, effective: provider.effective, saved: provider.saved, pending: provider.pending, tail: provider.tail},
      {provider: 'mistral', effective: 'mistral', saved: true, pending: false, tail: MISTRAL_KEY.slice(-4)});
    const log = bridge.errors();
    const keyAt = log.indexOf("Conversation key: the player's own"), providerAt = log.indexOf('Conversation provider: mistral');
    assert.ok(keyAt >= 0 && providerAt > keyAt, `the key switch comes before the provider switch\n${log}`);

    // The warm-up of the provider's connection (docs/LATENCY_2026-10-13.md) is the only outward request, and it names Mistral's host alone.
    const attempts = await bridge.until(() => bridge.forbidden(), lines => lines.some(line => line.includes('api.mistral.ai')), 'no warm-up request was attempted');
    for (const line of attempts) assert.match(line, /^fetch (?:data:,|https:\/\/api\.mistral\.ai\/)$/, 'a request to another address');

    // No key is in any file the bridge wrote for the game, in a log or in its output.
    const files = (await readdir(bridge.runtime)).map(name => join(bridge.runtime, name));
    const texts = [bridge.output(), bridge.errors(), ...await Promise.all(files.map(path => readFile(path, 'utf8').catch(() => '')))];
    for (const secret of [OWN_KEY, MISTRAL_KEY, SHARED_KEY]) assert.ok(!texts.some(text => text.includes(secret)), 'a key was written out');
  } finally { await bridge.cleanup(); }
});

describe('the settings file during the poll', {timeout: 120000}, () => {
  const settings = {audioDelay: 150, matureContent: true, localModel: 'lite', conversationProvider: 'local', useOwnConvaiKey: true, voice: false};
  let bridge;
  before(async () => {
    bridge = await launchBridge({settings, stateFiles: {'player-convai-key.txt': `api-key=${OWN_KEY}\n`}});
    await bridge.ready();
  }, {timeout: 60000});
  after(async () => { await bridge?.cleanup(); });

  // The values the saved file sets, each readable from a file the game reads or a line the log carries.
  async function choices() {
    const [delay, own, provider] = await Promise.all([bridge.read('audio-delay.json'), bridge.read('own-key-state.json'), bridge.read('mistral-state.json')]);
    return {delay: delay?.delayMs, delaySetting: delay?.setting, key: own?.active, provider: provider?.provider};
  }
  const SAVED = {delay: 150, delaySetting: 150, key: 'player', provider: 'local'};
  async function keptThrough(content) {
    const before = {errors: bridge.errors(), choices: await choices()};
    assert.deepEqual(before.choices, SAVED, 'the saved choices were in force');
    if (content === null) await bridge.remove('settings.json'); else await bridge.writeSettings(content);
    await bridge.idle(1300);   // at least two polls
    assert.deepEqual(await choices(), SAVED);
    assert.equal(bridge.errors(), before.errors, 'a poll that read nothing says nothing: no switch, no "setting is now off", no error');
  }

  test('the saved choices apply on the first poll', async () => {
    await bridge.until(choices, value => JSON.stringify(value) === JSON.stringify(SAVED), 'the saved choices were not applied');
    assert.match(bridge.errors(), /\[MatureContent\] setting is now on/);
    assert.match(bridge.errors(), /\[LocalAI\] model choice is now lite/);
  });
  test('an empty file (the game rewriting it in place) keeps every choice', async () => { await keptThrough(''); });
  test('a file cut off mid-write keeps every choice', async () => { await keptThrough('{"audioDelay": 0, "matureContent": fal'); });
  test('a file of zero bytes written as NULs (a writer that died) keeps every choice', async () => { await keptThrough('\u0000'.repeat(48)); });
  test('a file that is absent for an instant (removed, then renamed into place) keeps every choice', async () => { await keptThrough(null); });
  test('a complete file that names fewer settings applies: what it leaves out returns to its default', async () => {
    // The control for the tests above: the poll was running all along, and a valid file does change the choices.
    await bridge.writeSettings({});
    const reset = await bridge.until(choices, value => value.delay === 0 && value.key === 'shared' && value.provider === 'convai', 'a complete file was not applied');
    assert.equal(reset.delaySetting, 'auto');
    assert.match(bridge.errors(), /\[MatureContent\] setting is now off/);
    assert.match(bridge.errors(), /\[LocalAI\] model choice is now auto/);
  });
  test('and the next complete file brings the saved choices back', async () => {
    await bridge.writeSettings(settings);
    await bridge.until(choices, value => JSON.stringify(value) === JSON.stringify(SAVED), 'the saved choices did not come back');
  });
});
