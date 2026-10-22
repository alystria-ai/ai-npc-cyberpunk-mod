// What is released when the settings stop using it (docs/RESOURCE_LIFECYCLE.md): voice playback Off, the facial model, the hidden
// browser and its renderer pages, the microphone page, the audio-output probe. Fakes only: nothing is spawned, played or launched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp, mkdtempSync, writeFile, writeFileSync, rm, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {VoiceSelection} from './voice-selection.mjs';
import {JaliFace} from './jali-face.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {LocalStt, MODEL_FILES} from './local-stt.mjs';
import {createLocalSpeech} from './local-stt-capture.mjs';
import {AudioOutputWatch} from './audio-delay.mjs';
import {syntheticModel, speechLike} from './jali-face-fixture.mjs';
import {fakeClock} from './fixtures/fake-clock.mjs';

const tick = () => new Promise(done => setImmediate(done));
// Waits on the state, with a ceiling that only a hung test reaches (counting event-loop turns would depend on how fast the machine is).
const until = async (predicate, label) => {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) { if (predicate()) return; await tick(); }
  assert.fail('timed out waiting for ' + label);
};

// ---- Voice playback Off releases the local voice worker ------------------------------------------------------------------------

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

function voiceFixture(options = {}) {
  const events = [], workers = [], clockState = {now: 1_000_000};
  const ref = name => ({'judy-alvarez': {reference: `runtime/voice-references/${name}/judy.wav`, sha256: 'b'.repeat(64), transcript: 'A line.'}});
  const omni = name => ({version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16, voices: ref(name)});
  const factory = backend => (config, hooks) => {
    let loaded = false;
    const worker = {backend, starts: 0, closes: 0, closing: false, setSteps() {}, setKeepPrepared() {},
      get loaded() { return loaded; },
      hasProfile: key => Object.hasOwn(config.voices, key), profileReady(key) { return loaded && this.hasProfile(key); },
      async start() { this.starts++; events.push(backend + ' start'); loaded = true; hooks.onState({state: 'ready', resident: true}); },
      async prepareProfile(profile) { return {provider: backend, ready: true, profile}; },
      async synthesize() { return {}; }, async synthesizeStream() { return {frames: 1}; },
      async close() { this.closing = true; this.closes++; events.push(backend + ' close'); loaded = false; this.closed = true; hooks.onState({state: 'stopped', resident: false}); }};
    workers.push(worker); return worker;
  };
  const states = [];
  const voice = new VoiceSelection(pocketSettings(ref('pocket')), {factory: factory('pocket'), omniFactory: factory('omni'),
    omniConfigs: {short: omni('short'), long: omni('long')}, omniConfigPaths: {short: resolve('runtime/s.json'), long: resolve('runtime/l.json')},
    clock: () => clockState.now, previewSettleMs: 0, onState: value => { states.push(value.state); }, ...options});
  return {voice, workers, events, states, clockState, advance: ms => { clockState.now += ms; }};
}

test('voice playback Off releases the Pocket worker at once, and playback On loads it again', async () => {
  const h = voiceFixture();
  h.voice.update({voiceProvider: 'pocket', voice: true}, null, false);
  await h.voice.start();
  assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].loaded, true);
  h.voice.update({voice: false}, null, false);
  await until(() => h.workers[0].closes === 1, 'the worker to be released at the click, no grace period');
  assert.equal(h.workers[0].loaded, false);
  assert.equal(h.voice.silent, true);
  await h.voice.retiring;
  assert.equal(h.states.at(-1), 'stopped', 'the status says stopped, not "Convai voices"');
  h.advance(10 * 60_000);
  h.voice.update({voice: false}, null, false); await tick();
  assert.equal(h.workers.length, 1, 'nothing loads again while it stays Off');
  // Playback On again: the next poll loads it.
  h.voice.update({voice: true}, null, false);
  await until(() => h.workers.length === 2 && h.workers[1].loaded, 'the worker to load again');
  assert.equal(h.voice.silent, false);
  await h.voice.close();
  assert.equal(h.workers[1].closes, 1, 'closing the service releases it, once');
});

test('V on keeps the Pocket worker while playback is Off (V\'s line uses it); V off releases it', async () => {
  const h = voiceFixture();
  h.voice.update({voiceProvider: 'pocket', voice: true}, null, false);
  await h.voice.start();
  h.voice.setVHelperWanted(true);
  h.voice.update({voice: false}, null, false); await tick(); await tick();
  assert.equal(h.workers[0].closes, 0, 'V is on: the Pocket worker stays loaded for his line');
  assert.equal(h.workers[0].loaded, true);
  assert.equal(h.voice.usesProfile('judy-alvarez'), true, 'the voice is still routed, so V\'s line can use it');
  h.voice.setVHelperWanted(false);
  h.voice.update({voice: false}, null, false);
  await until(() => h.workers[0].closes === 1, 'the worker to be released when V is off too');
  await h.voice.close();

  // A game that starts with playback Off and V on loads the Pocket worker for V only.
  const start = voiceFixture();
  start.voice.setVHelperWanted(true);
  start.voice.update({voiceProvider: 'pocket', voice: false}, null, false);
  await start.voice.start();
  await until(() => start.workers.length === 1 && start.workers[0].loaded, 'the Pocket worker for V');
  await start.voice.close();
});

test('a game that starts with playback Off and V off never loads a worker; OmniVoice is released at once', async () => {
  const off = voiceFixture();
  off.voice.update({voiceProvider: 'pocket', voice: false}, null, false);
  await off.voice.start(); await tick();
  assert.equal(off.workers.length, 0, 'the first reading, Off, loads nothing');
  assert.equal(off.voice.silent, true);
  await off.voice.close();

  const omni = voiceFixture();
  omni.voice.update({voiceProvider: 'omni', omniSteps: 16, omniReference: 'short', voice: true}, null, false);
  await omni.voice.start();
  assert.equal(omni.workers[0].backend, 'omni');
  omni.voice.update({voice: false}, null, false);
  await until(() => omni.workers[0].closes === 1, 'OmniVoice to be released at once (its VRAM goes back)');
  assert.equal(omni.workers.length, 1, 'with V off no Pocket worker takes its place');
  await omni.voice.close();
});

test('while released, preparing a character does not load or wait for a worker; the receipt says muted', async () => {
  const h = voiceFixture();
  h.voice.update({voiceProvider: 'pocket', voice: false}, null, false);
  await tick();
  const receipt = await h.voice.prepareProfile('judy-alvarez');
  assert.deepEqual(receipt, {provider: 'pocket', ready: true, profile: 'judy-alvarez', muted: true});
  assert.equal(h.workers.length, 0, 'an invitation while muted starts nothing');
  await h.voice.close();
});

test('a settings draft that previews a local voice still warms it while playback is Off', async () => {
  const h = voiceFixture();
  h.voice.update({voiceProvider: 'convai', voice: false}, null, false); await tick();
  assert.equal(h.workers.length, 0);
  h.voice.update({voiceProvider: 'convai', voice: false}, {provider: 'pocket'}, false);
  await until(() => h.workers.length === 1, 'the previewed voice to load');
  await h.voice.close();
});

// ---- The facial model worker thread ----------------------------------------------------------------------------------------------

test('the facial model worker thread is released on suspend() and loads again on resume()', async () => {
  const {meta, buffer} = syntheticModel(), folder = mkdtempSync(join(tmpdir(), 'lifecycle-face-'));
  writeFileSync(join(folder, 'face-model.json'), JSON.stringify(meta)); writeFileSync(join(folder, 'face-model.bin'), buffer);
  const face = await JaliFace.load(folder, {respawnMs: 10});
  try {
    assert.equal(face.active, true);
    const first = face.worker;
    const exited = new Promise(done => first.once('exit', done));
    assert.equal(await face.suspend(), true);
    await exited;
    assert.equal(face.active, false);
    assert.equal(face.worker, null, 'the thread is gone');
    assert.throws(() => face.begin(16000), /unavailable/, 'a reply while suspended falls back to the envelope face');
    assert.equal(await face.suspend(), false, 'suspending twice does nothing');
    await new Promise(done => setTimeout(done, 40));
    assert.equal(face.worker, null, 'a suspended worker is never respawned by the crash recovery');
    assert.equal(await face.resume(), true);
    assert.notEqual(face.worker, null);
    const frames = await face.analyse(speechLike(.3, 16000), 16000);
    assert.equal(frames.finished, true, 'analysis works again after resume');
    // An analysis in flight is never cut off.
    const session = face.begin(16000);
    assert.equal(await face.suspend(), false);
    session.close();
  } finally { await face.close(); rmSync(folder, {recursive: true, force: true}); }
});

// ---- The hidden browser and its renderer pages -----------------------------------------------------------------------------------

async function browserFixture(t) {
  const directory = await new Promise((done, fail) => mkdtemp(join(tmpdir(), 'cyberpunk-lifecycle-'), (error, value) => error ? fail(error) : done(value)));
  for (const name of ['realtime-client.js', 'continuous-pcm-player.mjs', 'continuous-pcm-core.mjs', 'continuous-pcm-worklet.mjs', 'local-pcm-client.mjs']) {
    await new Promise((done, fail) => writeFile(join(directory, name), '// offline fixture\n', error => error ? fail(error) : done()));
  }
  const launches = [], pages = [];
  const host = new RealtimeHost({clientAssetsDirectory: directory, launchBrowser: async () => {
    const browser = {connected: true, isConnected() { return this.connected; }, async close() { this.connected = false; },
      async newPage() {
        const page = {closed: false, isClosed() { return this.closed; }, async route() {}, async goto() {}, async waitForFunction() {},
          async close() { this.closed = true; }, context: () => ({close: async () => {}})};
        pages.push(page); return page;
      }};
    launches.push(browser); return browser;
  }});
  t.after(async () => { await host.close(); await new Promise(done => rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}, done)); });
  return {host, launches, pages};
}

test('V\'s line page and the companions\' page are closed when unused, never while a turn owns one', async t => {
  const {host, pages} = await browserFixture(t);
  assert.equal(await host.prewarmLocal(), true);
  assert.equal(await host.prewarmVoiceLine(), true);
  assert.equal(pages.length, 2);
  assert.equal(await host.releaseRendererPages({line: true}), 1, 'V off: only V\'s page');
  assert.equal(pages[1].closed, true); assert.equal(pages[0].closed, false);
  assert.equal(await host.releaseRendererPages({line: true}), 0, 'nothing left to close');
  host.localPcm.active = {token: 'turn'};
  assert.equal(await host.releaseRendererPages({companion: true}), 0, 'a page that owns a turn is left alone');
  assert.equal(pages[0].closed, false);
  host.localPcm.active = null;
  assert.equal(await host.releaseRendererPages({companion: true}), 1, 'playback Off: the companions\' page');
  assert.equal(pages[0].closed, true);
  // The next warm-up opens a page again.
  assert.equal(await host.prewarmLocal(), true);
  assert.equal(pages.length, 3);
});

test('the hidden browser closes after its idle time when nothing uses it, and starts again on the next use', async t => {
  const {host, launches} = await browserFixture(t);
  await host.prewarmLocal();
  const idleMs = 300_000, soon = Date.now() + 1000, later = Date.now() + idleMs + 1000;
  assert.equal(await host.releaseIfIdle({idleMs, now: soon}), false, 'recent use keeps it');
  assert.equal(await host.releaseIfIdle({idleMs, now: later, keepRenderer: true}), false, 'a text provider with voice on keeps the renderer warm');
  host.voiceLease = {};
  assert.equal(await host.releaseIfIdle({idleMs, now: later}), false, 'a recording keeps it');
  host.voiceLease = null;
  host.localPcm.active = {token: 'turn'};
  assert.equal(await host.releaseIfIdle({idleMs, now: later}), false, 'a speaking turn keeps it');
  host.localPcm.active = null;
  host.retained = {keys: ['judy'], options: {}};   // the party's keys are only permission to keep a page, not a page
  assert.equal(await host.releaseIfIdle({idleMs, now: later}), true);
  assert.equal(launches[0].connected, false, 'the browser process is closed');
  assert.equal(host.browser, null);
  assert.equal(await host.releaseIfIdle({idleMs, now: later}), false, 'nothing to release twice');
  assert.equal(await host.prewarmLocal(), true, 'the next use starts a new browser');
  assert.equal(launches.length, 2);
});

test('a Convai page in the pool keeps the browser', async t => {
  const {host} = await browserFixture(t);
  await host.prewarmLocal();
  host.pool.entries.set('judy', {key: 'judy', busy: false});
  assert.equal(await host.releaseIfIdle({idleMs: 0, now: Date.now() + 1}), false);
  host.pool.entries.clear();
});

// ---- The local speech recogniser and its microphone page -------------------------------------------------------------------------

const ALL = new Set(['/py/python.exe', '/app/bridge/local-stt-worker.py', '/py/Lib/site-packages/sherpa_onnx', ...MODEL_FILES.map(name => '/model/' + name)]);
const existsIn = files => path => files.has(String(path).replace(/^[A-Za-z]:/, '').replaceAll('\\', '/'));
function sttFixture({exitsOnQuit = true} = {}, clock = fakeClock()) {
  const spawned = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 777; child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', null); };
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', text => {
      for (const line of text.split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.op === 'quit' && exitsOnQuit) setImmediate(() => child.emit('exit', 0));
      }
    });
    setTimeout(() => child.stdout.write(JSON.stringify({type: 'ready', engine: 'fake', threads: 1, loadMs: 1}) + '\n'), 0);
    spawned.push(child); return child;
  };
  const stt = new LocalStt({paths: {python: '/py/python.exe', worker: '/app/bridge/local-stt-worker.py', modelDirectory: '/model'},
    exists: existsIn(ALL), spawnImpl, lowerPriority: false, idleMs: 25, exitMs: 30, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  return {stt, spawned, clock};
}

test('the recogniser leaves after its idle time and the microphone page is closed with it', async () => {
  // The idle and exit limits run on a fake clock: they fire exactly when the test moves the clock to them, however busy the machine is
  // (a real 25 ms idle timer and 30 ms kill timer raced the fake process's exit and the test's own wait).
  const {stt, spawned, clock} = sttFixture();
  let captured = 0;
  const speech = createLocalSpeech({stt, capture: {close: async () => { captured++; }}});
  await stt.start('r1'); await stt.cancel('r1');
  assert.equal(spawned.length, 1);
  await clock.advance(24);
  assert.equal(captured, 0, 'the recogniser stays until its idle time is over');
  await clock.advance(1);
  assert.equal(captured, 1, 'the capture page is closed when the recogniser idles');
  assert.equal(stt.worker, null);
  await until(() => clock.pending() === 0, 'the process to exit on quit (which clears its kill timers)');
  assert.equal(spawned[0].killed, false, 'it left by itself on quit, nothing was killed');
  await speech.close();
});

test('closing the recogniser waits for the process to exit and kills one that ignores quit', async () => {
  const polite = sttFixture();
  await polite.stt.start('r1');
  await polite.stt.close();
  assert.equal(polite.spawned[0].killed, false);
  const stubborn = sttFixture({exitsOnQuit: false});
  await stubborn.stt.start('r1');
  let closed = false;
  const closing = stubborn.stt.close().then(() => { closed = true; });
  await stubborn.clock.advance(29);
  assert.equal(stubborn.spawned[0].killed, false, 'not killed before exitMs (30 ms) is over');
  assert.equal(closed, false, 'close waits for the process');
  await stubborn.clock.advance(1);
  assert.equal(stubborn.spawned[0].killed, true, 'a worker that does not leave on quit is killed after exitMs');
  await closing;
});

// ---- The audio-output probe ------------------------------------------------------------------------------------------------------

test('the audio-output probe can be suspended (hand-set delay or playback Off) and started again; stop() is for good', () => {
  const spawns = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; }; spawns.push(child); return child;
  };
  const watch = new AudioOutputWatch({spawnFn, platform: 'win32', setTimeoutFn: () => 1, clearTimeoutFn: () => {}});
  watch.start();
  assert.equal(watch.running, true);
  watch.suspend();
  assert.equal(spawns[0].killed, true, 'the PowerShell process is ended');
  assert.equal(watch.running, false);
  watch.suspend();
  watch.start();
  assert.equal(spawns.length, 2, 'it can start again');
  watch.stop();
  assert.equal(spawns[1].killed, true);
  watch.start();
  assert.equal(spawns.length, 2, 'stopped for good');
});

// ---- The bridge wires each release ---------------------------------------------------------------------------------------------

const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');

test('the bridge releases what settings stop using: facial model, renderer pages, idle browser, probe, embedder', () => {
  assert.match(bridge, /const BROWSER_IDLE_MS = 300_000;/);
  assert.match(bridge, /localVoice\.setVHelperWanted\(vVoice\.wantsPocket\);\s*void releaseUnused\(\)/, 'due-checked from the settings poll');
  assert.match(bridge, /if \(muted\) await jaliFace\.suspend\(\); else if \(!jaliFace\.active\) void jaliFace\.resume\(\);/);
  assert.match(bridge, /realtime\.releaseRendererPages\(\{line: !vVoice\.enabled \|\| !vVoice\.available, companion: muted\}\)/);
  assert.match(bridge, /releaseIfIdle\(\{idleMs: BROWSER_IDLE_MS, keepRenderer\}\)/);
  assert.match(bridge, /phoneRealtime\.releaseIfIdle\(\{idleMs: BROWSER_IDLE_MS\}\)/);
  assert.match(bridge, /if \(voiceBoundaryBusy\(\) \|\| voiceRouteReservation \|\| keySwitching \|\| providerSwitching\) return;/, 'pages only between turns');
  assert.match(bridge, /else audioWatch\.suspend\(\);/);
  assert.match(bridge, /if \(!mistral\.active && !addonHost\.active\) void localEmbedder\.close\(\)/);
  assert.match(bridge, /ready: key => localVoice\.vRouteSpeaks\(key\),/, 'V speaks with playback Off while his setting is on');
  assert.doesNotMatch(bridge, /ready: key => localVoice\.playbackEnabled/);
  assert.match(bridge, /const muted = localVoice\.silent;/, 'no grace period: the release follows the setting');
  assert.match(bridge, /prewarmVoice: \(\) => host === realtime && localVoice\.playbackEnabled !== false/, 'no browser warm-up while muted');
  assert.match(bridge, /Promise\.allSettled\(\[realtime\.close\(\), phoneRealtime\.close\(\), jaliFace\?\.close\(\)\]\)/, 'shutdown ends the facial thread too');
});

test('a provider switch closes the Convai pages and stops the local model server (audit: already in place, kept under test)', () => {
  const body = bridge.slice(bridge.indexOf('async function applyProviderChoice('), bridge.indexOf('async function applyProviderChoice(') + 2600);
  assert.match(body, /await Promise\.allSettled\(\[realtime\.close\(\), phoneRealtime\.close\(\)\]\);/);
  assert.match(body, /if \(mistral\.applied === 'local'\) void localServer\.ensure\(\{background: true\}\)\.catch\(\(\) => \{\}\);\s*else void localServer\.stop\(\)\.catch/);
  assert.match(bridge, /else if \(mistral\.localUnused\) void localServer\.stop\(\)/, 'a model loaded ahead and then withdrawn is stopped too');
  assert.match(bridge, /await Promise\.allSettled\(\[localServer\.stop\(\), localEmbedder\.close\(\)\]\)/, 'shutdown waits for both servers');
});

test('an invitation accepts the muted receipt: no loaded worker is waited for while playback is Off', () => {
  assert.match(bridge, /if \(receipt\.muted === true\) return localVoice\.playbackEnabled === false && receipt\.provider === localVoice\.provider && localVoice\.usesProfile\(profile\);/);
  assert.match(bridge, /if \(receipt\.muted === true && localVoice\.playbackEnabled === false\) \{\s*if \(receipt\.provider !== localVoice\.provider \|\| !localVoice\.usesProfile\(profile\)\) continue;/);
});
