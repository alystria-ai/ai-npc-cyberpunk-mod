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

test('V not wanted, or the Pocket voice itself: no helper; the Convai voice loads one only while V wants Pocket', async () => {
  const off = fixture(); await omniReady(off, {wanted: false});
  off.voice.setVHelperWanted(false); await tick();
  assert.equal(off.helperWorker(), undefined, 'V off, or on another engine');
  assert.equal(off.voice.vHelperReady('v-male'), false);
  off.voice.setVHelperWanted(true); await until(() => off.helperWorker()?.loaded, 'the helper');
  off.voice.setVHelperWanted(false); await until(() => off.helperWorker().closes === 1, 'the helper to be released');
  await off.voice.close();

  const pocket = fixture();
  pocket.voice.setVHelperWanted(true);
  pocket.voice.update({voiceProvider: 'pocket'}, null, false); await pocket.voice.start(); await tick();
  assert.equal(pocket.workers.length, 1, 'only the chosen Pocket worker');
  assert.equal(pocket.voice.vHelperSpeaks('v-male'), false, 'with the Pocket voice, V uses the chosen worker');
  assert.equal(pocket.voice.vRouteSpeaks('v-male'), true);
  await pocket.voice.close();

  // The Convai voice runs no worker: V on Pocket gets a Pocket worker of its own; V not on Pocket gets nothing.
  const convai = fixture();
  convai.voice.update({voiceProvider: 'convai'}, null, false); await convai.voice.start(); await tick();
  assert.equal(convai.workers.length, 0, 'V not wanted on Pocket: nothing loads');
  convai.voice.setVHelperWanted(true);
  await until(() => convai.helperWorker()?.loaded, "V's Pocket worker beside the Convai voice");
  assert.equal(convai.workers.length, 1);
  assert.equal(convai.voice.vHelperSpeaks('v-male'), true); assert.equal(convai.voice.vRouteSpeaks('v-male'), false);
  convai.voice.setVHelperWanted(false);
  await until(() => convai.helperWorker().closes === 1, "V's Pocket worker to be released (exit confirmed)");
  assert.equal(convai.voice.vHelper.running, false);
  await convai.voice.close();
});

test('voice playback Off with V on: OmniVoice is released at once, the helper stays and speaks V; with V off nothing stays', async () => {
  // Playback Off from the start: OmniVoice never loads, the helper does.
  const muted = fixture();
  muted.voice.request({voice: false}); await omniReady(muted);
  await until(() => muted.helperWorker()?.loaded, 'the helper to load with playback Off');
  assert.equal(muted.workers.filter(worker => worker.backend === 'omni').length, 0, 'no OmniVoice worker for a silent companion');
  assert.equal(muted.voice.vHelperReady('v-male'), true);
  assert.equal(muted.voice.vHelperSpeaks('v-male'), true);
  // V off as well: the helper goes and nothing is left.
  muted.voice.setVHelperWanted(false);
  await until(() => muted.helperWorker().closes === 1, 'the helper to be released');
  assert.equal(muted.workers.filter(worker => worker.backend === 'omni').length, 0);
  await muted.voice.close();

  // Playing, then Off: OmniVoice is released at the same poll, the helper keeps running (never restarted).
  const live = fixture();
  live.voice.request({voice: true}); await omniReady(live);
  await until(() => live.helperWorker()?.loaded, 'the helper');
  const omni = live.workers.find(worker => worker.backend === 'omni');
  assert.equal(omni.loaded, true);
  live.voice.update({voice: false}, null, false);
  await until(() => omni.closes === 1, 'OmniVoice to be released at once');
  assert.equal(live.helperWorker().closes, 0, 'V\'s helper stays');
  assert.equal(live.helperWorker().loaded, true);
  assert.equal(live.workers.filter(worker => worker.backend === 'pocket').length, 1, 'the helper was not restarted');
  // Playback On again: OmniVoice loads again, the running helper is kept beside its load.
  live.voice.update({voice: true}, null, false);
  await until(() => live.workers.filter(worker => worker.backend === 'omni').length === 2 && live.workers.at(-1).loaded, 'OmniVoice to load again');
  assert.equal(live.helperWorker().closes, 0);
  assert.equal(live.workers.filter(worker => worker.backend === 'pocket').length, 1);
  await live.voice.close();
});

const cloudVoice = (extra = {}) => ({hasKey: true, ready: true, setReferences() {}, async reference() {}, async synthesizeStream() { return {}; }, ...extra});

test('a cloud companion voice with V not on Pocket loads no local model of any kind; V on Pocket loads one Pocket worker for V only', async () => {
  const h = fixture({options: {voxtral: cloudVoice()}});
  h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start(); await tick();
  assert.equal(h.voice.cloudActive, true);
  assert.equal(h.voice.vHelperDue, false); assert.equal(h.voice.vHelper.running, false);
  assert.equal(h.workers.length, 0, 'V off or on the cloud voice: no local voice worker of any kind');
  // The player picks Pocket for V: its own worker loads, in the background, and nothing else does.
  h.voice.setVHelperWanted(true);
  await until(() => h.helperWorker()?.loaded, "V's Pocket worker");
  assert.equal(h.workers.length, 1, 'no OmniVoice and no second Pocket worker');
  assert.equal(h.voice.cloudActive, true, 'the companions still speak with the cloud voice');
  assert.equal(h.voice.vHelperSpeaks('v-male'), true); assert.equal(h.voice.vRouteSpeaks('v-male'), false);
  assert.equal(h.voice.vHelperReady('v-male'), true);
  // The player moves V to the cloud voice (or switches V off): the worker is released and its exit confirmed.
  h.voice.setVHelperWanted(false);
  await until(() => h.helperWorker().closes === 1, 'the worker to be released');
  await h.voice.vHelper.release();
  assert.equal(h.helperWorker().loaded, false); assert.equal(h.voice.vHelper.running, false);
  await h.voice.close();
  assert.equal(h.workers.length, 1, 'closing starts nothing');
});

test('a cloud companion voice with playback Off: V on Pocket keeps its own worker, V not on Pocket keeps nothing', async () => {
  const h = fixture({options: {voxtral: cloudVoice()}});
  h.voice.update({voiceProvider: 'voxtral', voice: false}, null, false); await h.voice.start(); await tick();
  assert.equal(h.workers.length, 0, 'no local voice worker of any kind');
  assert.equal(h.voice.vHelper.running, false);
  const receipt = await h.voice.prepareProfile('judy-alvarez');
  assert.equal(receipt.muted, true, 'the companions are silent: nothing is prepared for them');
  h.voice.setVHelperWanted(true);
  await until(() => h.helperWorker()?.loaded, "V's Pocket worker with the companions muted");
  assert.equal(h.workers.length, 1);
  h.voice.setVHelperWanted(false);
  await until(() => h.helperWorker().closes === 1, 'the worker to be released');
  await h.voice.close();
});

test("a settings preview of the Pocket voice releases V's worker first and gives it back when the preview ends, after the previewed worker has exited", async () => {
  const h = fixture({options: {voxtral: cloudVoice()}});
  h.voice.setVHelperWanted(true);
  h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
  await until(() => h.helperWorker()?.loaded, "V's worker");
  const vWorker = h.helperWorker();
  h.voice.prepare({provider: 'pocket'});              // the player is choosing the Pocket voice in Settings: its worker warms
  await until(() => h.workers.length === 2 && h.workers[1].loaded, 'the previewed Pocket worker');
  assert.equal(vWorker.closes, 1, "V's worker was released before the previewed one started");
  assert.ok(h.events.indexOf('pocket#1 closed') < h.events.indexOf('pocket#2 start'));
  assert.equal(h.voice.vHelper.running, false, 'never two Pocket workers (one work folder, one lock)');
  h.voice.prepare(null);                               // the player went back: the previewed worker leaves, V's comes back after it
  await until(() => h.workers.length === 3 && h.workers[2].loaded, "V's worker again");
  assert.ok(h.events.indexOf('pocket#2 closed') < h.events.indexOf('pocket#3 start'), "V's worker starts only after the previewed one has exited");
  await h.voice.close();
});

test("switching the companions from the cloud voice to Pocket: V's own worker leaves, the companions' worker takes over and speaks V", async () => {
  const h = fixture({options: {voxtral: cloudVoice()}});
  h.voice.setVHelperWanted(true);
  h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
  await until(() => h.helperWorker()?.loaded, "V's worker");
  h.voice.update({voiceProvider: 'pocket'}, null, false); await h.voice.start().catch(() => {});
  await until(() => h.workers.length === 2 && h.workers[1].loaded, "the companions' Pocket worker");
  assert.equal(h.workers[0].closes, 1);
  assert.equal(h.voice.pocketRoute, true); assert.equal(h.voice.vRouteSpeaks('v-male'), true); assert.equal(h.voice.vHelperSpeaks('v-male'), false);
  assert.equal(h.voice.vHelper.running, false);
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
  const failures = [];
  const h = fixture({failHelper: true, options: {onFailure: info => failures.push(info)}});
  await omniReady(h); await until(() => h.voice.vHelper.failed, 'the failure');
  await tick(); await tick();
  // The failure is told once, with its reason, and the setup check can see it while it lasts (the Help page's Pocket voice row).
  assert.deepEqual(failures, [{engine: 'v-helper', reason: 'helper failed'}]);
  assert.deepEqual(h.voice.voiceProblem(), {engine: 'v-helper', reason: 'helper failed'});
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
  assert.equal(h.voice.voiceProblem(), null, 'no problem once the voice is off or tried again');
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

test('V\'s worker finishing its load tells the bridge once (so V\'s voice is prepared before the first line); a worker released while loading does not', async () => {
  const ready = [];
  const h = fixture({options: {onVHelperReady: () => ready.push('ready')}});
  await omniReady(h);
  await until(() => h.helperWorker()?.loaded, 'the helper to load');
  await tick();
  assert.deepEqual(ready, ['ready']);
  h.voice.setVHelperWanted(false); await until(() => h.helperWorker().closes === 1, 'the helper to be released');
  await tick();
  assert.deepEqual(ready, ['ready'], 'a release is not a load');
  await h.voice.close();
  // A hook that throws never affects the worker.
  const broken = fixture({options: {onVHelperReady: () => { throw Error('hook failed'); }}});
  await omniReady(broken);
  await until(() => broken.helperWorker()?.loaded, 'the helper to load');
  assert.equal(broken.voice.vHelperReady('v-male'), true);
  await broken.voice.close();
});
