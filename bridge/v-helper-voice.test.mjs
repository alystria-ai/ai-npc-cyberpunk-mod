import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {VoiceSelection} from './voice-selection.mjs';
import {VHelperVoice} from './v-helper-voice.mjs';

// V's helper Pocket voice beside OmniVoice (docs/V_VOICE.md, "OmniVoice companions"). Fake workers only: nothing is spawned or played.

const tick = () => new Promise(done => setImmediate(done));
const defer = () => { let resolveIt; const promise = new Promise(done => { resolveIt = done; }); return {resolve: resolveIt, promise}; };
const until = async (predicate, label) => { for (let at = 0; at < 200; at++) { if (predicate()) return; await tick(); } assert.fail('timed out waiting for ' + label); };

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

function fixture({holdPocketClose = false, failHelper = false, options = {}} = {}) {
  const events = [], workers = [];
  const ref = name => ({'judy-alvarez': {reference: `runtime/voice-references/${name}/judy.wav`, sha256: 'b'.repeat(64), transcript: 'A line.'},
    'v-male': {reference: `runtime/voice-references/${name}/v-male.wav`, sha256: 'c'.repeat(64), transcript: 'V says something.'}});
  const omni = name => ({version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16, voices: ref(name)});
  let pocketCount = 0;
  const factory = backend => (config, hooks) => {
    const {onState} = hooks;
    let loaded = false;
    const index = backend === 'pocket' ? ++pocketCount : 0;
    // The first Pocket worker made while OmniVoice is committed is V's helper; the label says which one it is.
    const worker = {backend, index, hooks, starts: 0, closes: 0, calls: [], prepared: [], closing: false, setSteps() {}, setKeepPrepared() {},
      get loaded() { return loaded; },
      hasProfile: key => Object.hasOwn(config.voices, key), profileReady(key) { return loaded && this.hasProfile(key); },
      async start() {
        this.starts++; events.push(`${backend}#${index} start`);
        if (failHelper && backend === 'pocket') { this.failure = Error('helper failed'); onState({state: 'error'}); throw this.failure; }
        loaded = true; events.push(`${backend}#${index} ready`); onState({state: 'ready', resident: true});
      },
      async prepareProfile(profile) { this.prepared.push(profile); return {provider: backend, ready: true, profile}; },
      async synthesize() { return {}; },
      async synthesizeStream(profile, text, options) { this.calls.push({profile, text, ...options}); return {frames: 1}; },
      async close() {
        this.closing = true; this.closes++; events.push(`${backend}#${index} closing`);
        if (holdPocketClose && backend === 'pocket') await holdPocketClose.promise;
        loaded = false; events.push(`${backend}#${index} closed`); onState({state: 'stopped', resident: false});
      }};
    workers.push(worker); return worker;
  };
  const logs = [];
  const voice = new VoiceSelection(pocketSettings(ref('pocket')), {factory: factory('pocket'), omniFactory: factory('omni'),
    omniConfigs: {short: omni('short'), long: omni('long')}, omniConfigPaths: {short: resolve('runtime/s.json'), long: resolve('runtime/l.json')},
    onLog: line => logs.push(line), previewSettleMs: 0, ...options});
  const helperWorker = () => workers.find(worker => worker.backend === 'pocket');
  return {voice, workers, events, logs, helperWorker};
}

const omniSettings = {voiceProvider: 'omni', omniSteps: 16, omniReference: 'short'};

async function omniReady(h, {wanted = true} = {}) {
  h.voice.update(omniSettings, null, false);
  await h.voice.start();
  if (wanted) h.voice.setVHelperWanted(true);
  await tick();
}

test('the helper loads only after the OmniVoice worker is ready, and only while V is wanted', async () => {
  const h = fixture();
  h.voice.setVHelperWanted(true);
  h.voice.update(omniSettings, null, false);
  assert.equal(h.workers.filter(worker => worker.backend === 'pocket').length, 0, 'no Pocket worker before OmniVoice is loaded');
  await h.voice.start(); await tick();
  await until(() => h.helperWorker()?.loaded, 'the helper to load');
  assert.deepEqual(h.events.filter(line => /start|ready/.test(line)), ['omni#0 start', 'omni#0 ready', 'pocket#1 start', 'pocket#1 ready'],
    'OmniVoice is ready first; the helper never loads beside its load');
  assert.equal(h.voice.provider, 'omni');
  assert.equal(h.voice.vHelperReady('v-male'), true);
  assert.equal(h.voice.vHelperSpeaks('v-male'), true);
  assert.match(h.logs.join(''), /\[VHelper\] V's helper voice is ready/);
  await h.voice.close();
});

test('V off, a muted voice playback, the Pocket voice or the Convai voice: no helper is ever loaded', async () => {
  const off = fixture(); await omniReady(off, {wanted: false});
  off.voice.setVHelperWanted(false); await tick();
  assert.equal(off.helperWorker(), undefined, 'V off');
  assert.equal(off.voice.vHelperReady('v-male'), false);
  off.voice.setVHelperWanted(true); await until(() => off.helperWorker()?.loaded, 'the helper');
  off.voice.setVHelperWanted(false); await until(() => off.helperWorker().closes === 1, 'the helper to be released');
  await off.voice.close();

  const muted = fixture();
  muted.voice.request({voice: false}); await omniReady(muted); await tick();
  assert.equal(muted.helperWorker(), undefined, 'voice playback off');
  await muted.voice.close();

  const pocket = fixture();
  pocket.voice.setVHelperWanted(true);
  pocket.voice.update({voiceProvider: 'pocket'}, null, false); await pocket.voice.start(); await tick();
  assert.equal(pocket.workers.length, 1, 'only the chosen Pocket worker');
  assert.equal(pocket.voice.vHelperSpeaks('v-male'), false, 'with the Pocket voice, V uses the chosen worker');
  await pocket.voice.close();

  const convai = fixture();
  convai.voice.setVHelperWanted(true);
  convai.voice.update({voiceProvider: 'convai'}, null, false); await convai.voice.start(); await tick();
  assert.equal(convai.workers.length, 0);
  await convai.voice.close();
});

test('a cloud voice never loads the helper: no local voice model, not even for V', async () => {
  const cloud = {hasKey: true, ready: true, setReferences() {}, async synthesizeStream() { return {}; }};
  const h = fixture({options: {voxtral: cloud}});
  h.voice.setVHelperWanted(true);
  h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start(); await tick();
  assert.equal(h.voice.cloudActive, true);
  assert.equal(h.voice.vHelperDue, false); assert.equal(h.voice.vHelper.running, false);
  assert.equal(h.voice.vHelperSpeaks('v-male'), false);
  assert.equal(h.workers.length, 0, 'no local voice worker of any kind');
  await h.voice.close();
});

test('switching to the Pocket voice releases the helper first: its lock is free before the chosen Pocket worker starts', async () => {
  const closing = defer();
  const h = fixture({holdPocketClose: closing});
  await omniReady(h); await until(() => h.helperWorker()?.loaded, 'the helper');
  h.voice.update({voiceProvider: 'pocket'}, null, false);
  assert.equal(h.voice.provider, 'pocket');
  const started = h.voice.start();
  await tick(); await tick();
  assert.equal(h.workers.filter(worker => worker.backend === 'pocket').length, 2, 'the chosen Pocket worker object exists');
  const chosen = h.workers.filter(worker => worker.backend === 'pocket')[1];
  assert.equal(chosen.starts, 0, 'the chosen Pocket worker waits for the helper\'s confirmed exit');
  assert.ok(h.events.includes('pocket#1 closing'));
  closing.resolve(); await started;
  assert.equal(chosen.starts, 1);
  assert.ok(h.events.indexOf('pocket#1 closed') < h.events.indexOf('pocket#2 start'), 'closed, then started');
  assert.equal(h.voice.vHelper.running, false, 'no helper beside the chosen Pocket worker');
  await h.voice.close();
});

test('the helper never starts while another Pocket worker is still stopping', async () => {
  const stopping = defer();
  const seen = [];
  const helper = new VHelperVoice({wait: () => stopping.promise, create: () => ({loaded: false, async start() { seen.push('start'); this.loaded = true; }, async close() {}, hasProfile: () => true})});
  helper.start(); await tick(); await tick();
  assert.deepEqual(seen, [], 'waiting for the other worker\'s exit');
  stopping.resolve(); await until(() => helper.loaded, 'the helper');
  assert.deepEqual(seen, ['start']);
  await helper.release();
});

test('a release while the helper waits to start cancels the start', async () => {
  const stopping = defer();
  const closed = [];
  const worker = {loaded: false, starts: 0, async start() { this.starts++; }, async close() { closed.push('closed'); }, hasProfile: () => true};
  const helper = new VHelperVoice({wait: () => stopping.promise, create: () => worker});
  helper.start(); await tick();
  const released = helper.release();
  stopping.resolve(); await released; await tick(); await tick();
  assert.equal(worker.starts, 0); assert.deepEqual(closed, ['closed']); assert.equal(helper.running, false);
});

test('a failed helper stays off with one log line and no retry loop; V stays silent until the voice or the setting changes', async () => {
  const h = fixture({failHelper: true});
  await omniReady(h); await until(() => h.voice.vHelper.failed, 'the failure');
  await tick(); await tick();
  const attempts = h.workers.filter(worker => worker.backend === 'pocket').length;
  assert.equal(attempts, 1);
  for (let at = 0; at < 5; at++) { h.voice.update(omniSettings, null, false); h.voice.vHelperReady('v-male'); await tick(); }
  assert.equal(h.workers.filter(worker => worker.backend === 'pocket').length, 1, 'no retry loop');
  assert.equal(h.logs.filter(line => /helper voice failed/.test(line)).length, 1);
  assert.equal(h.voice.vHelperReady('v-male'), false);
  assert.equal(h.voice.provider, 'omni', 'OmniVoice and the companions are untouched');
  // Turning V off and on again tries once more.
  h.voice.setVHelperWanted(false); await tick();
  assert.equal(h.voice.vHelper.failed, false);
  h.voice.setVHelperWanted(true); await tick();
  await until(() => h.workers.filter(worker => worker.backend === 'pocket').length === 2, 'a second attempt');
  await h.voice.close();
});

test('the helper streams V\'s line (tags removed) and prepares V\'s voice; with no loaded worker both are refused and nothing waits', async () => {
  const h = fixture();
  await assert.rejects(h.voice.vHelperStream('v-male', 'Hi'), /not loaded/);
  assert.deepEqual(await h.voice.vHelperPrepare('v-male'), {ready: false});
  await omniReady(h); await until(() => h.helperWorker()?.loaded, 'the helper');
  await h.voice.vHelperStream('v-male', 'Hello [laughter] there.', {onPcm() {}});
  assert.equal(h.helperWorker().calls[0].profile, 'v-male'); assert.equal(h.helperWorker().calls[0].text, 'Hello there.');
  await h.voice.vHelperPrepare('v-male');
  assert.deepEqual(h.helperWorker().prepared, ['v-male']);
  assert.equal(h.workers.find(worker => worker.backend === 'omni').calls.length, 0, 'OmniVoice\'s worker is never asked for V');
  await h.voice.close();
});

test('closing the voice service releases the helper, once, and confirms its exit', async () => {
  const h = fixture();
  await omniReady(h); await until(() => h.helperWorker()?.loaded, 'the helper');
  await h.voice.close();
  assert.equal(h.helperWorker().closes, 1); assert.equal(h.helperWorker().loaded, false);
  assert.equal(h.voice.vHelper.running, false);
  h.voice.setVHelperWanted(false); h.voice.setVHelperWanted(true); await tick();
  assert.equal(h.workers.filter(worker => worker.backend === 'pocket').length, 1, 'a closed service starts nothing');
});
