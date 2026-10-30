// The Inworld cloud voice as a choice (docs/INWORLD.md): the rules around it that bridge/inworld-voice.test.mjs does not pin. It is a cloud voice like the
// Mistral one, on the player's own Inworld key: it loads no local model (not even as a backup), a local voice that fails is never given to it, nothing of
// it runs while it is not chosen, it is not used beside Mature content, and it appears in no other voice slot (V's voice engine is Pocket, Voxtral or OmniVoice).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {VoiceSelection, canonicalVoiceProvider, cloudVoiceChoice, CLOUD_VOICES} from './voice-selection.mjs';
import {VVoice, V_ENGINES} from './v-voice.mjs';
import {neededServices} from './setup-check.mjs';
import {InworldVoice} from './inworld-voice.mjs';
import {InworldKey} from './inworld-key.mjs';
import {MistralControl, MistralProvider} from './mistral-key.mjs';
import {BRIDGE_MODULES} from '../packaging/runtime-layout.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';

const KEY = Buffer.from('test-key-id-0123456789:test-key-secret-abcdefghijklmnopqrstuvwxyz').toString('base64');

// A cloud engine that only counts what it is asked: any call while Inworld is not the chosen voice is a failure of the rule.
class CountingInworld {
  constructor() { this.calls = []; this.hasKey = true; this.ready = true; this.degraded = null; this.spoke = 0; this.fellBack = 0; this.chars = 0; this.cooldownMs = 0; }
  setReferences() {}
  replaceReferences() { return []; }
  hasCachedReference() { return false; }
  warm(key) { this.calls.push(['warm', key]); }
  async synthesizeStream(key) { this.calls.push(['speak', key]); throw Error('not expected'); }
}

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

function selection({inworld = new CountingInworld(), pocketFails = false, barred = false} = {}) {
  const workers = [], synthesized = [];
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
  const voice = new VoiceSelection(pocketSettings(voices), {inworld, cloudBarred: () => barred,
    factory: (config, {onState}) => {
      workers.push(config);
      let loaded = false;
      return {get loaded() { return loaded; }, hasProfile: name => Object.hasOwn(config.voices, name), profileReady: name => loaded && Object.hasOwn(config.voices, name),
        async prepareProfile(name) { return {provider: 'pocket', ready: true, profile: name}; },
        async start() { loaded = true; onState({state: 'ready', resident: true}); },
        async synthesizeStream(name, text, options) {
          synthesized.push(name);
          if (pocketFails) throw Error('the Pocket voice failed');
          await options.onPcm?.({marker: 'pocket'}); return {audio: 'pocket'};
        },
        async close() { loaded = false; onState({state: 'stopped'}); }};
    }});
  return {voice, inworld, workers, synthesized};
}

test('Inworld is one of the cloud voices: it rides on Pocket\'s route, the menu name is its own, and it is not a voice for V', () => {
  assert.deepEqual([...CLOUD_VOICES], ['voxtral', 'inworld']);
  assert.equal(cloudVoiceChoice('inworld'), 'inworld');
  assert.equal(canonicalVoiceProvider('inworld'), 'pocket', 'the route is Pocket\'s (packet format and routing only)');
  assert.equal(cloudVoiceChoice('pocket'), null);
  const voice = new VoiceSelection({}, {inworld: new CountingInworld()});
  voice.request({voiceProvider: 'inworld'});
  assert.equal(voice.requestedCloud, 'inworld'); assert.equal(voice.requestedProvider, 'pocket'); assert.equal(voice.cloudWanted, true);
  voice.request({voiceProvider: 'voxtral'});
  assert.equal(voice.requestedCloud, 'voxtral', 'the choice moves from one cloud voice to the other');
  voice.request({voiceProvider: 'convai'});
  assert.equal(voice.requestedCloud, null); assert.equal(voice.requestedProvider, 'convai');
  // V keeps her own three engines: a saved Inworld reads as Pocket there.
  const v = new VVoice({voices: {male: {key: 'v-male'}}});
  assert.deepEqual(V_ENGINES, ['pocket', 'voxtral', 'omni']);
  v.update({vVoiceEngine: 'voxtral'});
  assert.equal(v.engine, 'voxtral');
  assert.doesNotThrow(() => v.update({vVoiceEngine: 'inworld'}));
  assert.equal(v.engine, 'pocket');
});

test('Mature content bars every cloud voice: a saved Inworld choice is read as Pocket and the engine is never asked', async () => {
  const barred = selection({barred: true});
  barred.voice.update({voiceProvider: 'inworld'}, null, false);
  assert.equal(barred.voice.requestedCloud, null); assert.equal(barred.voice.cloudWanted, false);
  await barred.voice.start();
  assert.equal(barred.voice.cloudActive, false);
  await barred.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}});
  assert.deepEqual(barred.inworld.calls, []);
  assert.equal(barred.synthesized.length, 1, 'Pocket speaks it');
  await barred.voice.close();
  const free = selection({barred: false});
  free.voice.update({voiceProvider: 'inworld'}, null, false);
  assert.equal(free.voice.requestedCloud, 'inworld');
  await free.voice.close();
});

test('a local voice that fails is never given to Inworld: the reply is not sent to the cloud and nothing warms it', async () => {
  const h = selection({pocketFails: true});
  h.voice.update({voiceProvider: 'pocket'}, null, false);
  await h.voice.start();
  assert.equal(h.voice.cloudWanted, false);
  await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}}), /Pocket voice failed/);
  const receipt = await h.voice.prepareProfile('judy-alvarez');
  assert.notEqual(receipt.cloudVoice, 'inworld');
  assert.deepEqual(h.inworld.calls, [], 'Inworld was not asked and not warmed');
  await h.voice.close();
});

test('Inworld chosen loads no local model, not even as a backup; chosen away, it is no longer warmed or asked', async () => {
  const h = selection();
  h.voice.update({voiceProvider: 'inworld'}, null, false);
  await h.voice.start();
  assert.equal(h.voice.cloudActive, true); assert.equal(h.workers.length, 0, 'no Pocket worker was created');
  const receipt = await h.voice.prepareProfile('judy-alvarez');
  assert.equal(receipt.cloudVoice, 'inworld'); assert.equal(h.workers.length, 0);
  assert.deepEqual(h.inworld.calls, [['warm', 'judy-alvarez']], 'preparing a character only starts making its voice');
  // A failed ask is written text: the local voice never speaks it.
  await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}}));
  assert.equal(h.workers.length, 0); assert.equal(h.synthesized.length, 0);
  // Away from it: Pocket loads, Inworld is left alone.
  const before = h.inworld.calls.length;
  h.voice.update({voiceProvider: 'pocket'}, null, false);
  await h.voice.start();
  assert.equal(h.voice.cloudActive, false); assert.equal(h.workers.length, 1);
  await h.voice.prepareProfile('judy-alvarez');
  await h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}});
  assert.equal(h.inworld.calls.length, before, 'no further call to Inworld once it is not chosen');
  await h.voice.close();
});

test('nothing of Inworld runs until it is chosen: building it and running a Pocket session makes no request and reads no clip', async () => {
  let fetched = 0, read = 0;
  const inworld = new InworldVoice({getKey: () => KEY, referenceRoot: resolve('fixture'), registry: [], storePath: 'voices.json',
    fetchImpl: async () => { fetched++; throw Error('no request expected'); }, readText: async () => { read++; throw Error('missing'); }});
  const h = selection({inworld});
  h.voice.update({voiceProvider: 'pocket'}, null, false);
  await h.voice.start();
  await h.voice.prepareProfile('judy-alvarez');
  await h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}});
  assert.equal(fetched, 0); assert.equal(read, 0); assert.equal(inworld.entries.size, 0);
  await h.voice.close();
});

test('the setup check names Inworld\'s host only while Inworld is the chosen voice', () => {
  assert.deepEqual(neededServices({voiceProvider: 'inworld'}), ['convai', 'inworld']);
  assert.deepEqual(neededServices({conversationProvider: 'mistral', voiceProvider: 'inworld'}), ['mistral', 'inworld']);
  assert.deepEqual(neededServices({voiceProvider: 'pocket'}), ['convai']);
});

test('the Inworld key commands: Add reads the clipboard, Remove deletes, Test asks the free voice list; the status holds only the last four characters', async () => {
  const files = {mistral: '', inworld: ''}, published = [], store = {key: null};
  const inworld = new InworldKey({keyPath: 'i', readText: async () => { if (!store.key) throw Error('missing'); return `api-key=${store.key}\n`; },
    writeText: async (_path, text) => { store.key = /api-key=(\S+)/.exec(text)[1]; }, removeFile: async () => { store.key = null; }});
  const provider = new MistralProvider({keyPath: 'm', inworld, readText: async () => { throw Error('missing'); }, writeText: async () => {}, removeFile: async () => {}});
  let clipboard = async () => KEY, verdict = 'valid';
  const control = new MistralControl({provider, commandPath: 'mistral', inworldCommandPath: 'inworld', model: () => 'm', publish: async value => { published.push(value); },
    readClipboard: () => clipboard(), validate: async () => 'valid', validateInworld: async () => verdict, read: async path => files[path], now: () => 7_000_000});
  await control.open();
  let sequence = 0;
  const send = async (action, file = 'inworld') => {
    files[file] = JSON.stringify({version: 1, id: `session:ikey:${++sequence}`, action, issuedAt: 7_000_000});
    await (file === 'inworld' ? control.pollInworld() : control.pollMistral());
    return published.at(-1);
  };
  assert.equal((await send('test')).inworld.result.state, 'no-key', 'nothing saved: nothing to test');
  clipboard = async () => { throw Error('no clipboard'); };
  assert.equal((await send('paste')).inworld.result.state, 'unreadable');
  clipboard = async () => 'not a key at all, just a sentence';
  assert.equal((await send('paste')).inworld.result.state, 'invalid');
  clipboard = async () => KEY; verdict = 'invalid';
  assert.equal((await send('paste')).inworld.result.state, 'invalid', 'Inworld refused it: not saved'); assert.equal(store.key, null);
  verdict = 'valid';
  const saved = await send('paste');
  assert.equal(saved.inworld.result.state, 'saved'); assert.equal(saved.inworld.saved, true); assert.equal(saved.inworld.tail, KEY.slice(-4)); assert.equal(store.key, KEY);
  assert.equal(JSON.stringify(published).includes(KEY), false, 'the key is in no status');
  assert.deepEqual(provider.secrets().includes(KEY), true, 'reports scrub it');
  verdict = 'valid'; assert.equal((await send('test')).inworld.result.state, 'connected');
  verdict = 'invalid'; assert.equal((await send('test')).inworld.result.state, 'refused');
  verdict = 'unknown'; assert.equal((await send('test')).inworld.result.state, 'unreachable');
  assert.equal(store.key, KEY, 'a test never changes the key');
  // The test action belongs to this file only: the Mistral file ignores it.
  const count = published.length;
  await send('test', 'mistral');
  assert.equal(published.length, count, 'the Mistral command file does not take a test command');
  assert.equal((await send('clear')).inworld.result.state, 'cleared'); assert.equal(store.key, null);
  assert.equal(published.at(-1).inworld.saved, false);
  assert.equal(files.inworld.includes(KEY), false);
});

test('the Inworld modules ship with the Runtime and are not on the removal list', async () => {
  assert.ok(BRIDGE_MODULES.includes('bridge/inworld-key.mjs') && BRIDGE_MODULES.includes('bridge/inworld-voice.mjs'));
  assert.ok(!BRIDGE_MODULES.includes('bridge/inworld-steering.mjs'), 'the steering module stays gone: Flash ignores steering');
  const removals = JSON.parse(await readFile(new URL('../packaging/runtime-removals.json', import.meta.url), 'utf8')).removes.join('\n');
  assert.doesNotMatch(removals, /inworld-key|inworld-voice/);
  assert.match(removals, /inworld-steering/);
  const exchange = await readFile(new URL('../packaging/runtime-exchange.json', import.meta.url), 'utf8');
  assert.match(exchange, /inworld-key-command\.json/);
});
