import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {VoiceSelection} from './voice-selection.mjs';
import {ResidentVoice} from './resident-voice.mjs';

// Multilingual conversations: Settings move the voice to OmniVoice or the cloud voice; the voice selection keeps
// a fallback from ever landing on Pocket (English only) while the setting is on. Fake workers; nothing spawns.
const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});
const voices = {'johnny-silverhand': {reference: 'runtime/voice-references/johnny.wav', sha256: 'a'.repeat(64), transcript: 'Original line.'}};

function fixture({fail = []} = {}) {
  const workers = [];
  const factory = backend => (config, hooks) => {
    let loaded = false;
    const worker = {backend, calls: [], get loaded() { return loaded; }, hasProfile: key => Object.hasOwn(config.voices, key),
      profileReady(key) { return loaded && this.hasProfile(key); }, setSteps() {},
      async start() {
        if (fail.includes(backend)) { this.failure = Error(backend + ' failed'); hooks.onState({state: 'error'}); throw this.failure; }
        loaded = true; hooks.onState({state: 'ready'});
      },
      async prepareProfile(profile) { return {provider: backend, ready: true, profile}; },
      async synthesize(profile, text, options) { this.calls.push({profile, text, ...options}); return {audio: 'wav'}; },
      async synthesizeStream() { return {}; },
      async close() { loaded = false; hooks.onState({state: 'stopped'}); },
    };
    workers.push(worker); return worker;
  };
  const voice = new VoiceSelection(pocketSettings(voices), {factory: factory('pocket'), omniFactory: factory('omni'),
    omniConfig: {version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 32, voices}, omniConfigPath: resolve('runtime/local-voices.json')});
  return {voice, workers};
}
const tick = () => new Promise(done => setImmediate(done));

test('an OmniVoice choice that cannot run shows text, never Pocket and never the cloud voice, with Multilingual on or off', async () => {
  const off = fixture({fail: ['omni']});
  off.voice.update({voiceProvider: 'omni'}, null, false); await off.voice.start().catch(() => {}); await tick();
  off.voice.update({voiceProvider: 'omni'}, null, false);
  assert.equal(off.voice.provider, 'text', 'off: text; Pocket is not loaded in place of OmniVoice');
  await off.voice.close();
  const on = fixture({fail: ['omni']});
  on.voice.update({voiceProvider: 'omni', multilingualConversations: true}, null, false);
  await on.voice.start().catch(() => {}); await tick();
  on.voice.update({voiceProvider: 'omni', multilingualConversations: true}, null, false);
  assert.equal(on.voice.provider, 'text'); assert.deepEqual(on.voice.fallback, {from: 'omni', to: 'text', temporary: true}); // Omni is retried in the background
  assert.equal(on.workers.filter(worker => worker.backend === 'pocket').length, 0);
  await on.voice.close();
});

test('a hand-edited Pocket choice with Multilingual on ends on text (Pocket speaks English only; no cloud voice takes over); off again restores Pocket', async () => {
  const h = fixture();
  h.voice.update({voiceProvider: 'pocket', multilingualConversations: true}, null, false);
  assert.equal(h.voice.provider, 'text'); assert.equal(h.voice.convaiVoiceAllowed, false);
  assert.equal(h.voice.usesProfile('johnny-silverhand'), false);
  // A busy turn keeps its route until the idle boundary.
  h.voice.update({voiceProvider: 'pocket', multilingualConversations: false}, null, true);
  assert.equal(h.voice.provider, 'text');
  h.voice.update({voiceProvider: 'pocket', multilingualConversations: false}, null, false);
  assert.equal(h.voice.provider, 'pocket');
  await h.voice.close();
});

test('OmniVoice chosen: a reply in another language reaches the worker with its language', async () => {
  const h = fixture();
  h.voice.update({voiceProvider: 'omni', omniSteps: 16, multilingualConversations: true}, null, false); await h.voice.start();
  assert.deepEqual(h.voice.languageOmni('johnny-silverhand'), {usable: true, ready: true});
  await h.voice.synthesize('johnny-silverhand', 'こんばんは、V。', {language: 'ja'});
  const omni = h.workers.find(worker => worker.backend === 'omni');
  assert.deepEqual(omni.calls, [{profile: 'johnny-silverhand', text: 'こんばんは、V。', language: 'ja', steps: 16}]);
  h.voice.update({voiceProvider: 'convai', multilingualConversations: true}, null, false);
  assert.deepEqual(h.voice.languageOmni('johnny-silverhand'), {usable: false, ready: false});
  await h.voice.close();
});

test('the resident worker sends the language only for non-English replies and rejects malformed codes', async () => {
  const sent = [];
  const worker = new ResidentVoice({version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 32, voices}, {project: resolve('.'),
    configPath: resolve('runtime/local-voices.json')});
  worker.ensurePrepared = async () => {};
  worker.command = async (kind, profile, payload) => { sent.push(payload); return {audio: Buffer.alloc(0).toString('base64')}; };
  const render = language => worker.synthesize('johnny-silverhand', 'Text.', {steps: 16, language}).catch(error => error);
  await render('es'); await render('en'); await render(undefined);
  assert.deepEqual(sent.map(payload => payload.language), ['es', undefined, undefined]);
  assert.match((await render('es-ES; rm')).message, /Invalid speech language/);
});
