import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {VoiceSelection} from './voice-selection.mjs';
import {ResidentVoice} from './resident-voice.mjs';

// Multilingual conversations: while Pocket is the chosen voice, a second OmniVoice-only worker speaks the replies
// that are not in English. Fake workers record what reached them; nothing spawns.
const tick = () => new Promise(done => setImmediate(done));
const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});
const voices = {'johnny-silverhand': {reference: 'runtime/voice-references/johnny.wav', sha256: 'a'.repeat(64), transcript: 'Original line.'},
  'judy-alvarez': {reference: 'runtime/voice-references/judy.wav', sha256: 'b'.repeat(64), transcript: 'Another line.'}};

function fixture({pack = true, failLanguage = false, omniVoices = voices} = {}) {
  const workers = [], events = [];
  const factory = backend => (config, hooks) => {
    let loaded = false;
    const worker = {backend, config, hooks, configPath: hooks.configPath, starts: 0, closes: 0, steps: 32, calls: [],
      get loaded() { return loaded; }, hasProfile: key => Object.hasOwn(config.voices, key),
      profileReady(key) { return loaded && this.hasProfile(key); }, setSteps(value) { this.steps = value; },
      async start() {
        this.starts++; events.push('start:' + backend);
        if (failLanguage && backend === 'omni') { this.failure = Error('no CUDA'); hooks.onState({state: 'error'}); throw this.failure; }
        loaded = true; hooks.onState({state: 'ready', resident: true});
      },
      async prepareProfile(profile) { return {provider: backend, ready: true, profile}; },
      async synthesize(profile, text, options) { this.calls.push({profile, text, ...options}); return {audio: 'wav'}; },
      async synthesizeStream(profile, text) { this.calls.push({profile, text, stream: true}); return {}; },
      async close() { this.closes++; events.push('close:' + backend); loaded = false; hooks.onState({state: 'stopped'}); },
    };
    workers.push(worker); return worker;
  };
  const states = [];
  const voice = new VoiceSelection(pocketSettings(voices), {onState: value => states.push(value), factory: factory('pocket'),
    omniFactory: factory('omni'), omniConfig: {version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 32, voices: omniVoices},
    omniConfigPath: resolve('runtime/local-voices.json'),
    omniPack: () => pack ? {installed: true, missing: []} : {installed: false, missing: ['model']}});
  return {voice, workers, events, states, omni: () => workers.filter(worker => worker.backend === 'omni')};
}

test('off, or without the pack, no OmniVoice worker is ever started for other languages', async () => {
  const off = fixture();
  assert.deepEqual(off.voice.languageOmni('johnny-silverhand'), {usable: false, ready: false});
  await off.voice.warmLanguageOmni(); assert.equal(off.omni().length, 0);
  await assert.rejects(off.voice.synthesize('johnny-silverhand', 'Hola.', {language: 'es'}), /cannot speak/);
  await off.voice.close();
  const noPack = fixture({pack: false});
  noPack.voice.setMultilingual(true);
  assert.deepEqual(noPack.voice.languageOmni('johnny-silverhand'), {usable: false, ready: false});
  await noPack.voice.warmLanguageOmni(); assert.equal(noPack.omni().length, 0);
  await noPack.voice.close();
});

test('on with Pocket chosen: the worker starts on demand, speaks with the language and leaves Pocket alone', async () => {
  const h = fixture();
  await h.voice.start(); assert.equal(h.workers[0].backend, 'pocket');
  h.voice.setMultilingual(true);
  assert.deepEqual(h.voice.languageOmni('johnny-silverhand'), {usable: true, ready: false}, 'never warmed ahead');
  assert.equal(h.omni().length, 0);
  await h.voice.warmLanguageOmni();
  assert.deepEqual(h.voice.languageOmni('johnny-silverhand'), {usable: true, ready: true});
  assert.equal(h.omni().length, 1); assert.equal(h.omni()[0].hooks.configPath, resolve('runtime/local-voices.json'));
  assert.equal(h.omni()[0].steps, 16, 'the saved Omni quality (16 by default)');
  await h.voice.synthesize('johnny-silverhand', 'Hola, V. [laughter] ¿Qué tal?', {language: 'es'});
  assert.deepEqual(h.omni()[0].calls, [{profile: 'johnny-silverhand', text: 'Hola, V. [laughter] ¿Qué tal?', language: 'es', steps: 16}]);
  assert.equal(h.voice.provider, 'pocket'); assert.equal(h.workers[0].closes, 0, 'Pocket keeps running');
  // An English request still requires the chosen engine (Omni is not the chosen voice).
  await assert.rejects(h.voice.synthesize('johnny-silverhand', 'Hello.'), /does not use OmniVoice/);
  assert.equal(h.states.at(-1).languageOmni.state, 'ready'); assert.equal(h.states.at(-1).multilingual, true);
  // Turning the setting off releases it.
  h.voice.setMultilingual(false); await tick();
  assert.equal(h.omni()[0].closes, 1); assert.deepEqual(h.voice.languageOmni('johnny-silverhand'), {usable: false, ready: false});
  await h.voice.close();
});

test('a character without an Omni reference is not usable, and a failed worker stays out until the setting is turned on again', async () => {
  const partial = fixture({omniVoices: {'judy-alvarez': voices['judy-alvarez']}});
  partial.voice.setMultilingual(true);
  assert.equal(partial.voice.languageOmni('johnny-silverhand').usable, false);
  assert.equal(partial.voice.languageOmni('judy-alvarez').usable, true);
  await partial.voice.close();
  const h = fixture({failLanguage: true});
  h.voice.setMultilingual(true);
  await h.voice.warmLanguageOmni().catch(() => {}); await tick(); await tick();
  assert.deepEqual(h.voice.languageOmni('johnny-silverhand'), {usable: false, ready: false});
  assert.equal(h.states.at(-1).languageOmni.unavailable, true);
  h.voice.setMultilingual(false); h.voice.setMultilingual(true);
  assert.equal(h.voice.languageOmni('johnny-silverhand').usable, true, 'turning it on again retries');
  await h.voice.close();
});

test('with OmniVoice chosen the main worker speaks every language and no second worker exists', async () => {
  const h = fixture();
  h.voice.update({voiceProvider: 'omni', omniSteps: 32}, null, false); await h.voice.start();
  h.voice.setMultilingual(true);
  assert.deepEqual(h.voice.languageOmni('johnny-silverhand'), {usable: true, ready: true});
  await h.voice.warmLanguageOmni();
  await h.voice.synthesize('johnny-silverhand', 'こんばんは、V。', {language: 'ja'});
  assert.equal(h.omni().length, 1, 'one Omni worker only');
  assert.deepEqual(h.omni()[0].calls, [{profile: 'johnny-silverhand', text: 'こんばんは、V。', language: 'ja', steps: 32}]);
  await h.voice.close();
});

test('choosing OmniVoice releases the multilingual worker before the main one starts (one model slot)', async () => {
  const h = fixture();
  await h.voice.start(); h.voice.setMultilingual(true); await h.voice.warmLanguageOmni();
  assert.equal(h.omni().length, 1);
  h.voice.update({voiceProvider: 'omni', omniSteps: 16}, null, false); await h.voice.start(); await tick();
  const order = h.events.filter(event => event.endsWith(':omni'));
  assert.deepEqual(order, ['start:omni', 'close:omni', 'start:omni'], order.join(', '));
  assert.equal(h.omni()[0].closes, 1); assert.equal(h.omni()[1].hooks.configPath, resolve('runtime/local-voices.json'));
  assert.equal(h.voice.languageClient, null);
  // Back to Pocket: the multilingual worker waits for the main Omni worker's exit, then may start again on demand.
  h.voice.update({voiceProvider: 'pocket'}, null, false); await h.voice.start(); await tick();
  assert.equal(h.omni()[1].closes, 1);
  assert.deepEqual(h.voice.languageOmni('johnny-silverhand'), {usable: true, ready: false});
  await h.voice.warmLanguageOmni(); assert.equal(h.omni().length, 3);
  await h.voice.close(); assert.equal(h.omni()[2].closes, 1, 'closing the service releases it');
});

test('the resident worker sends the language only for non-English replies and rejects malformed codes', async () => {
  const sent = [];
  const worker = new ResidentVoice({version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 32, voices}, {project: resolve('.'),
    configPath: resolve('runtime/local-voices.json')});
  worker.ensurePrepared = async () => {};
  worker.command = async (kind, profile, payload) => { sent.push(payload); return {audio: Buffer.alloc(0).toString('base64')}; };
  const silent = async (language) => worker.synthesize('johnny-silverhand', 'Text.', {steps: 16, language}).catch(error => error);
  await silent('es'); await silent('en'); await silent(undefined);
  assert.deepEqual(sent.map(payload => payload.language), ['es', undefined, undefined]);
  assert.match((await silent('es-ES; rm')).message, /Invalid speech language/);
});
