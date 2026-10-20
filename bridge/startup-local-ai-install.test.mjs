// What the bridge does when the pack for the chosen provider turns up while the game runs, and what a launch with voice playback Off
// starts. Both are watched on a real bridge process (bridge/bridge-run-fixture.mjs), like bridge/startup-local-ai-order.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {launchBridge, matureOnlyPack} from './bridge-run-fixture.mjs';

const FAKE_SERVER = 'llama/llama-server.exe';
const standardPack = {
  'manifest.json': JSON.stringify({version: 1, server: FAKE_SERVER,
    standard: {file: 'models/standard.gguf', name: 'Qwen3.5-4B'}, lite: {file: 'models/lite.gguf', name: 'Bonsai-2-4B'}}),
  [FAKE_SERVER]: 'fake server',
  'models/standard.gguf': 'x'.repeat(4000), 'models/lite.gguf': 'x'.repeat(2000),
};
const startedModels = async bridge => (await bridge.llama()).filter(event => event.event === 'spawn')
  .map(event => event.args[event.args.indexOf('-m') + 1].split(/[\\/]/).pop());
// The pack is looked for again at most every 5 s, so a start after an install can take that long and then a poll.
const firstStart = bridge => bridge.until(async () => (await startedModels(bridge))[0], Boolean, 'no model was ever started', 20000);
const status = bridge => bridge.read('mistral-state.json');

test('Local AI is chosen before its pack is installed: the pack extracted while the game runs is started without choosing another provider', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', voice: false}, fakeLlama: FAKE_SERVER});
  try {
    await bridge.ready();
    const waiting = await bridge.until(() => status(bridge), value => value?.localAi === 'not-installed', 'the missing pack was not reported');
    assert.equal(waiting.provider, 'local');
    assert.equal(waiting.effective, 'local', 'Local AI stays the provider: its turns say why it cannot answer yet, and never go to Convai');
    assert.deepEqual(await startedModels(bridge), []);
    await bridge.installPack(standardPack);
    assert.equal(await firstStart(bridge), 'standard.gguf');
    assert.match(bridge.errors(), /\[LocalAI\] a model was installed: starting the local model/);
    assert.deepEqual((await bridge.forbidden()).filter(line => !/^fetch /.test(line)), []);
  } finally { await bridge.cleanup(); }
});

test('only Mature models are installed and Mature content is off: a model that needs no Mature content, added while the game runs, is started', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', matureContent: false, voice: false},
    localAi: matureOnlyPack(), fakeLlama: FAKE_SERVER});
  try {
    await bridge.ready();
    const blocked = await bridge.until(() => status(bridge), value => value?.localReason === 'mature-off', 'mature-off was not reported');
    assert.equal(blocked.localAi, 'failed');
    await bridge.idle(1000);
    assert.deepEqual(await startedModels(bridge), [], 'nothing was loaded');
    await bridge.installPack(standardPack);
    assert.equal(await firstStart(bridge), 'standard.gguf');
    assert.match(bridge.errors(), /\[LocalAI\] a model that needs no Mature content was installed: starting the local model/);
  } finally { await bridge.cleanup(); }
});

test('the failure stays while nothing it waited for has appeared: no start is retried, however often the pack is looked at', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', matureContent: false, voice: false},
    localAi: matureOnlyPack(), fakeLlama: FAKE_SERVER});
  try {
    await bridge.ready();
    await bridge.until(() => status(bridge), value => value?.localReason === 'mature-off', 'mature-off was not reported');
    await bridge.idle(7000);   // more than one 5 s look at the pack
    assert.deepEqual(await startedModels(bridge), []);
    assert.ok((await bridge.llama()).filter(event => event.event === 'list-devices').length <= 1, 'one failed start, not a retry loop');
    assert.doesNotMatch(bridge.errors(), /starting the local model/);
  } finally { await bridge.cleanup(); }
});

// A text provider with voice playback Off needs no hidden browser. The default (playback on) is what the bridge holds until the first poll
// has read the setting, and it used to start the browser (the voice's renderer) in the poll that applies the saved provider.
const mistralKey = {'player-mistral-key.txt': 'mistralFixtureKey0123456789abcdefgh\n'};
const browserStarts = bridge => bridge.forbidden().then(lines => lines.filter(line => /^spawn .*fake-browser/.test(line)));
// The browser start is made to reach the point where the guard sees it on every machine: the page assets are stand-in files (a built bridge
// has them in runtime/, a checkout may not) and the browser is a file that is no browser (the guard refuses the spawn and records it).
const pageAssets = Object.fromEntries(['realtime-client.js', 'continuous-pcm-player.mjs', 'continuous-pcm-worklet.mjs', 'continuous-pcm-core.mjs',
  'local-pcm-client.mjs'].map(name => [`assets/${name}`, '']));
const browserWorld = {localAi: {...pageAssets, 'fake-browser.exe': 'not a browser'}, env: {CYBERPUNK_CONVAI_CLIENT_ASSETS: folder => join(folder, 'local-ai', 'assets'),
  CYBERPUNK_CONVAI_BROWSER: folder => join(folder, 'local-ai', 'fake-browser.exe')}};

test('a text provider with voice playback Off does not start the hidden browser at launch', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'mistral', voice: false}, stateFiles: mistralKey, ...browserWorld});
  try {
    await bridge.ready();
    await bridge.until(() => status(bridge), value => value?.provider === 'mistral', 'the saved provider was not applied');
    await bridge.idle(2500);
    assert.deepEqual(await browserStarts(bridge), [], 'a browser was started for a voice that is off');
  } finally { await bridge.cleanup(); }
});

test('the same launch with voice playback On warms the hidden browser (so the first reply does not wait for it)', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'mistral', voice: true}, stateFiles: mistralKey, ...browserWorld});
  try {
    await bridge.ready();
    await bridge.until(() => status(bridge), value => value?.provider === 'mistral', 'the saved provider was not applied');
    const lines = await bridge.until(() => browserStarts(bridge), value => value.length > 0, 'no browser start was attempted with voice on');
    assert.ok(lines.length > 0);
  } finally { await bridge.cleanup(); }
});
