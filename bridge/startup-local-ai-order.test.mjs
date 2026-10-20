// The startup order of the Local AI choice, watched on a real bridge process (bridge/bridge-run-fixture.mjs).
//
// At launch the bridge applies the saved conversation provider on the FIRST settings poll, and that poll starts the local model server
// (prepareLocal). It reads Mature content and the saved model choice first, so the first start loads what the player chose. A `llama-server`
// that the guard fakes records what the server was told to load, so these tests see the first start's decision, not a regex over the source.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchBridge, matureOnlyPack} from './bridge-run-fixture.mjs';

const FAKE_SERVER = 'llama/llama-server.exe';
// A Local AI pack with a standard and a lite model. The files are tiny: every model "fits" the fake card's 7000 MiB free.
const standardPack = {
  'manifest.json': JSON.stringify({version: 1, server: FAKE_SERVER,
    standard: {file: 'models/standard.gguf', name: 'Qwen3.5-4B'}, lite: {file: 'models/lite.gguf', name: 'Bonsai-2-4B'}}),
  [FAKE_SERVER]: 'fake server',
  'models/standard.gguf': 'x'.repeat(4000), 'models/lite.gguf': 'x'.repeat(2000),
};
const startedModels = async bridge => (await bridge.llama()).filter(event => event.event === 'spawn')
  .map(event => event.args[event.args.indexOf('-m') + 1].split(/[\\/]/).pop());
const firstStart = bridge => bridge.until(async () => (await startedModels(bridge))[0], Boolean, 'no model was ever started', 12000);
const status = bridge => bridge.read('mistral-state.json');

test('a Mature-only install whose saved provider is Local AI loads its Mature model at launch when Mature content is saved on', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', matureContent: true, voice: false},
    localAi: matureOnlyPack(), fakeLlama: FAKE_SERVER});
  try {
    await bridge.ready();
    // Mature content is read before the first start, so that start loads the Mature model (it never fails 'mature-off' on a value that was not the player's).
    assert.equal(await firstStart(bridge), 'mature-lite.gguf');
    // And the page is not left saying "turn Mature content on" while it is on (the fake server then refuses to run, which is a different failure).
    const settled = await bridge.until(() => status(bridge), value => value?.localAi === 'failed' && value.localReason === undefined,
      'the stale mature-off failure is still standing');
    assert.equal(settled.provider, 'local');
    assert.equal(settled.maturePack, true);
    assert.deepEqual(await bridge.forbidden(), []);
  } finally { await bridge.cleanup(); }
});

test('with Mature content off the same install reports mature-off and loads nothing; turning Mature content on while the bridge runs starts the model', {timeout: 60000}, async () => {
  const settings = {conversationProvider: 'local', matureContent: false, voice: false};
  const bridge = await launchBridge({settings, localAi: matureOnlyPack(), fakeLlama: FAKE_SERVER});
  try {
    await bridge.ready();
    const blocked = await bridge.until(() => status(bridge), value => value?.localReason === 'mature-off', 'mature-off was not reported');
    assert.equal(blocked.localAi, 'failed');
    assert.equal(blocked.provider, 'local');
    assert.equal(blocked.effective, 'local', 'Local AI stays the provider (its turns say mature-off); nothing goes to Convai');
    assert.equal(blocked.localModelDefault, undefined, 'no default model is offered while only Mature models exist and Mature content is off');
    assert.equal(blocked.localModelMatureDefault, 'mature:lite', 'the model that turning Mature content on selects');
    await bridge.idle(1500);
    assert.deepEqual(await startedModels(bridge), [], 'nothing was loaded');
    assert.ok((await bridge.llama()).filter(event => event.event === 'list-devices').length <= 1, 'one failed start, not a retry loop');

    await bridge.writeSettings({...settings, matureContent: true});
    assert.equal(await firstStart(bridge), 'mature-lite.gguf');
    assert.match(bridge.errors(), /\[MatureContent\] setting is now on/);
    const lifted = await bridge.until(() => status(bridge), value => value?.localReason === undefined, 'mature-off stayed after Mature content was turned on');
    assert.equal(lifted.provider, 'local');
  } finally { await bridge.cleanup(); }
});

test('a provider other than Local AI loads no model at launch, with a pack installed and Mature content on', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'convai', matureContent: true, voice: false},
    localAi: {...standardPack, ...matureOnlyPack()}, fakeLlama: FAKE_SERVER});
  try {
    await bridge.ready();
    await bridge.idle(1500);
    // No server is asked for its devices or started until the player chooses Local AI (its memory belongs to the game). The one designed
    // probe is nvidia-smi's total memory, for the size marks of the model list (two or more models installed), a short query and no model.
    assert.deepEqual((await bridge.llama()).filter(event => event.event !== 'nvidia-smi'), []);
    const shown = await bridge.until(() => status(bridge), value => Array.isArray(value?.localModels) && value.localModels.length === 3, 'the models were not listed');
    assert.deepEqual(shown.localModels.map(model => model.id).sort(), ['lite', 'mature:lite', 'standard']);
    assert.equal(shown.provider, 'convai');
    assert.deepEqual(await bridge.forbidden(), []);
  } finally { await bridge.cleanup(); }
});

// The same order, for the two other things the first start reads. The local server takes its model choice when a start begins
// (local-llm-server.mjs, #startOnce), and nothing reloads it afterwards (the first sync only records the choice), so the poll that applies the
// provider has to know the saved `localModel` and Mature content already: `matureContent.update` and `syncLocalModelChoice` come before it.
test('the model the player saved is the one the first start loads', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', localModel: 'lite', voice: false},
    localAi: standardPack, fakeLlama: FAKE_SERVER});
  try {
    await bridge.ready();
    assert.equal(await firstStart(bridge), 'lite.gguf');
  } finally { await bridge.cleanup(); }
});

test('with Mature content saved on and an uncensored model installed beside the standard one, the first start loads the uncensored model', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', matureContent: true, voice: false},
    localAi: {...standardPack, ...matureOnlyPack()}, fakeLlama: FAKE_SERVER});
  try {
    await bridge.ready();
    assert.equal(await firstStart(bridge), 'mature-lite.gguf');
  } finally { await bridge.cleanup(); }
});

test('a saved OmniVoice request without the OmniVoice pack does not hold the Local AI start back', {timeout: 60000}, async () => {
  // The supervisor waits (up to two minutes) for OmniVoice to load first when it is requested AND installed; without the pack it falls back at once.
  const bridge = await launchBridge({settings: {conversationProvider: 'local', voiceProvider: 'omni', matureContent: true},
    localAi: matureOnlyPack(), fakeLlama: FAKE_SERVER,
    env: {CYBERPUNK_CONVAI_PYTHON: folder => `${folder}\\no-python.exe`}});
  try {
    await bridge.ready();
    assert.equal(await firstStart(bridge), 'mature-lite.gguf');
    const voice = await bridge.read('local-voice-state.json');
    assert.equal(voice.omniPack.installed, false);
    assert.ok(voice.omniPack.missing.includes('python'));
  } finally { await bridge.cleanup(); }
});
