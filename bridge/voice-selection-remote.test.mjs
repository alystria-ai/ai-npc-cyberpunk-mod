// Remote OmniVoice in the voice service (bridge/voice-selection.mjs, docs/REMOTE_OMNIVOICE.md): the setting `remoteOmni` and the saved address turn the OmniVoice worker into a
// client of a server on the network. Nothing of OmniVoice loads on this PC, a server that cannot be reached means written replies (never Pocket, never a cloud voice) and
// is asked again soon, and no error report is filed for it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {VoiceSelection} from './voice-selection.mjs';
import {RemoteVoice, REMOTE_RETRY_DELAYS_MS} from './remote-voice.mjs';
import {ResidentVoice} from './resident-voice.mjs';

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), inputIdentity: 'e'.repeat(64), selectedStep: 1500}});
const voices = {'johnny-silverhand': {reference: 'runtime/voice-references/johnny.wav', sha256: 'a'.repeat(64), transcript: 'Original line.'}};
const omniConfig = {version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 32, voices};
const tick = () => new Promise(done => setImmediate(done));

function rig({address = '192.168.1.20:8765', failStarts = 0, pack = {installed: false, missing: ['python']}, cardMiB = null, omniFactory} = {}) {
  const workers = [], failures = [], logs = []; let now = 1_000_000, remaining = failStarts, saved = address;
  const make = backend => (config, hooks) => {
    let loaded = false;
    const worker = {backend, hooks, starts: 0, closes: 0, remote: backend === 'omni' ? voice.omniRemote : undefined,
      get loaded() { return loaded; }, hasProfile: key => Object.hasOwn(config.voices, key), profileReady(key) { return loaded && this.hasProfile(key); },
      setSteps() {}, setKeepPrepared() {}, async prepareProfile(profile) { return {provider: 'omnivoice', ready: true, profile}; },
      async synthesize() { return {}; }, async synthesizeStream() { return {}; },
      async start() {
        this.starts++;
        if (backend === 'omni' && remaining-- > 0) { this.failure = Error('Remote OmniVoice server cannot be reached (looking for it)'); hooks.onState({state: 'error'}); throw this.failure; }
        loaded = true; hooks.onState({state: 'ready', resident: false, engine: backend === 'omni' ? 'omnivoice' : 'pocket-tts'});
      },
      async close() { this.closes++; loaded = false; hooks.onState({state: 'stopped'}); }};
    workers.push(worker); return worker;
  };
  const voice = new VoiceSelection(pocketSettings(voices), {factory: make('pocket'), omniFactory: omniFactory ?? make('omni'), omniConfig, clock: () => now,
    omniPack: () => pack, omniRemoteAddress: () => saved, gpuMemoryMiB: () => cardMiB, onFailure: info => failures.push(info), onLog: line => logs.push(line)});
  return {voice, workers, failures, logs, advance: ms => { now += ms; }, setAddress: value => { saved = value; }};
}

test('remote on: OmniVoice needs no local pack, and the worker is the remote client', async () => {
  const h = rig();
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  assert.equal(h.voice.omniPack.installed, true, 'the pack is not needed on this PC');
  assert.deepEqual(h.voice.omniRemote, {host: '192.168.1.20', port: 8765});
  await h.voice.start();
  assert.equal(h.voice.provider, 'omni'); assert.equal(h.voice.fallback, null);
  assert.deepEqual(h.workers.map(worker => worker.backend), ['omni']);
  assert.deepEqual(h.workers[0].remote, {host: '192.168.1.20', port: 8765});
  assert.equal(h.voice.omniNoNvidia, false); assert.equal(h.voice.omniAmdRoute, false); assert.equal(h.voice.omniSmallCard, false);
  await h.voice.close();
});

test('remote off with no local pack: OmniVoice stays unavailable as before', async () => {
  const h = rig();
  h.voice.update({voiceProvider: 'omni', remoteOmni: false}, null, false);
  assert.equal(h.voice.omniPack.installed, false); assert.equal(h.voice.omniRemote, null);
  assert.equal(h.voice.provider, 'text');
  await h.voice.close();
});

test('the default OmniVoice factory builds a RemoteVoice for a server and a ResidentVoice for this PC', async () => {
  const h = rig({omniFactory: undefined}); const real = new VoiceSelection(pocketSettings(voices), {omniConfig, omniRemoteAddress: () => 'gaming-pc.local', omniPack: () => ({installed: true})});
  real.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  const remote = real.omniFactory(omniConfig, {onState() {}, onLog() {}});
  assert.ok(remote instanceof RemoteVoice); assert.deepEqual(remote.endpoint, {host: 'gaming-pc.local', port: 8765});
  real.update({voiceProvider: 'omni', remoteOmni: false}, null, false);
  assert.ok(real.omniFactory(omniConfig, {onState() {}, onLog() {}, project: process.cwd()}) instanceof ResidentVoice);
  await real.close(); await h.voice.close();
});

test('the local card and memory rules do not apply to a server: no Pocket in its place', async () => {
  const local = rig({cardMiB: 4000, pack: {installed: true}});
  local.voice.update({voiceProvider: 'omni', remoteOmni: false}, null, false);
  assert.equal(local.voice.omniNoMemory, true, 'sanity: a small local card is replaced by Pocket');
  await local.voice.close();
  const h = rig({cardMiB: 4000});
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  await h.voice.start();
  assert.equal(h.voice.omniNoMemory, false); assert.equal(h.voice.provider, 'omni');
  assert.ok(!h.workers.some(worker => worker.backend === 'pocket'), 'Pocket was not started');
  await h.voice.close();
});

test('a server that cannot be reached: written replies, no Pocket, no error report, asked again soon, then it takes over', async () => {
  const h = rig({failStarts: 1});
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  await assert.rejects(h.voice.start(), /cannot be reached/);
  await tick();
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  assert.equal(h.voice.provider, 'text'); assert.equal(h.voice.textOnly, true);
  assert.equal(h.voice.fallback.to, 'text'); assert.equal(h.voice.fallback.reason, 'omni-remote'); assert.equal(h.voice.fallback.temporary, true);
  assert.equal(h.voice.convaiVoiceAllowed, false);
  assert.ok(!h.workers.some(worker => worker.backend === 'pocket'), 'no Pocket worker was started in its place');
  assert.deepEqual(h.failures, [], 'a server of the player\'s own network files no error report');
  assert.equal(h.voice.omniRetry.failures, 1);
  // not yet due
  h.advance(REMOTE_RETRY_DELAYS_MS[0] - 100); h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  assert.equal(h.voice.candidate, null);
  h.advance(200); h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  assert.ok(h.voice.candidate, 'the background retry started');
  await h.voice.candidate.starting; await tick();
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false); await h.voice.start();
  assert.equal(h.voice.provider, 'omni'); assert.equal(h.voice.fallback, null);
  assert.ok(!h.workers.some(worker => worker.backend === 'pocket'));
  await h.voice.close();
});

test('the retry goes on for as long as the voice is wanted (the last wait repeats)', async () => {
  const h = rig({failStarts: 99});
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  await assert.rejects(h.voice.start()); await tick();
  for (let round = 1; round <= 7; round++) {
    h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
    assert.ok(h.voice.omniRetry, `a retry is scheduled after failure ${round}`);
    assert.equal(h.voice.omniRetry.nextAt - 1_000_000 - (h.voice.clock() - 1_000_000), REMOTE_RETRY_DELAYS_MS[Math.min(round - 1, REMOTE_RETRY_DELAYS_MS.length - 1)]);
    h.advance(REMOTE_RETRY_DELAYS_MS.at(-1) + 1);
    h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
    await h.voice.candidate?.starting; await tick(); await tick();
  }
  assert.ok(h.voice.omniRetry, 'still trying');
  await h.voice.close();
});

test('remote on with no address saved: OmniVoice cannot speak, replies are written, nothing starts', async () => {
  const h = rig({address: ''});
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  assert.equal(h.voice.omniRemoteUnset, true); assert.equal(h.voice.provider, 'text');
  assert.equal(h.workers.length, 0);
  h.setAddress('192.168.1.20'); h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  assert.equal(h.voice.provider, 'omni');
  await h.voice.start();
  assert.equal(h.workers.length, 1);
  await h.voice.close();
});

test('turning remote off, or changing the address, replaces the worker at the next idle moment', async () => {
  const h = rig({pack: {installed: true}});
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  await h.voice.start();
  const first = h.workers[0]; assert.deepEqual(first.remote, {host: '192.168.1.20', port: 8765});
  h.setAddress('192.168.1.30:9000');
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, true);      // a reply is running: the worker stays
  assert.equal(first.closes, 0);
  h.voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false); await h.voice.retiring; await h.voice.start();
  assert.equal(first.closes, 1); assert.deepEqual(h.workers[1].remote, {host: '192.168.1.30', port: 9000});
  h.voice.update({voiceProvider: 'omni', remoteOmni: false}, null, false); await h.voice.retiring; await h.voice.start();
  assert.equal(h.workers[1].closes, 1); assert.equal(h.workers[2].remote, null);
  await h.voice.close();
});

test('remote on: Pocket and every OmniVoice quality are rendered by the server (2026-10-28 report: it only engaged on one entry)', async () => {
  const entries = [{voiceProvider: 'pocket'},
    {voiceProvider: 'omni', omniSteps: 16, omniReference: 'short'}, {voiceProvider: 'omni', omniSteps: 16, omniReference: 'long'},
    {voiceProvider: 'omni', omniSteps: 32, omniReference: 'short'}, {voiceProvider: 'omni', omniSteps: 32, omniReference: 'long'}];
  for (const entry of entries) {
    const h = rig();
    h.voice.update({...entry, remoteOmni: true}, null, false);
    await h.voice.start();
    assert.equal(h.voice.requestedProvider, 'omni', JSON.stringify(entry));
    assert.equal(h.voice.provider, 'omni', JSON.stringify(entry));
    assert.deepEqual(h.workers.map(worker => worker.backend), ['omni'], 'no Pocket worker beside the server: ' + JSON.stringify(entry));
    assert.deepEqual(h.workers[0].remote, {host: '192.168.1.20', port: 8765});
    if (entry.omniSteps) assert.equal(h.voice.requestedOmniSteps, entry.omniSteps);
    await h.voice.close();
  }
});

test('remote on with Pocket chosen: Pocket is used until an address is saved, then the server takes over; remote off puts Pocket back', async () => {
  const h = rig({address: ''});
  h.voice.update({voiceProvider: 'pocket', remoteOmni: true}, null, false);
  assert.equal(h.voice.requestedProvider, 'pocket'); assert.equal(h.voice.provider, 'pocket');
  h.setAddress('192.168.1.20:8765'); h.voice.update({voiceProvider: 'pocket', remoteOmni: true}, null, false);
  assert.equal(h.voice.requestedProvider, 'omni'); assert.equal(h.voice.provider, 'omni');
  h.voice.update({voiceProvider: 'pocket', remoteOmni: false}, null, false);
  assert.equal(h.voice.requestedProvider, 'pocket');
  await h.voice.close();
});

test('remote on does not take a cloud voice or the Convai voice away from the player', async () => {
  for (const choice of ['voxtral', 'convai']) {
    const h = rig();
    h.voice.update({voiceProvider: choice, remoteOmni: true}, null, false);
    assert.notEqual(h.voice.requestedProvider, 'omni', choice);
    await h.voice.close();
  }
});
