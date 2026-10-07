import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {PassThrough, Writable} from 'node:stream';
import {resolve} from 'node:path';
import {ResidentVoice, LOCAL_VOICE_KEYS, VOICE_WORKER_LIMITS} from './resident-voice.mjs';
import {silentWav} from './speech-audio.mjs';

const config = {provider: 'hybrid', engine: 'omnivoice',
  voices: Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {
    reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.',
  }]))};
const tick = () => new Promise(done => setImmediate(done));
function harness({autoReady = true, timers, settings = config, protocolVersion = 1, pythonExecutable,
  workerOptions = {}, readyFields = {}} = {}) {
  const states = [], requests = [], launches = []; let starts = 0;
  const child = new EventEmitter();
  child.kills = 0; child.kill = () => { child.kills++; return true; };
  child.pid = 1234; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({write(chunk, encoding, done) {
    requests.push(JSON.parse(chunk.toString())); done();
  }});
  const send = frame => child.stdout.write(JSON.stringify(frame) + '\n');
  const ready = (extra = {}) => send({op: 'ready', profiles: Object.entries(settings.voices)
    .filter(([, value]) => !value.status || value.status === 'ready').map(([key]) => key),
    ...(protocolVersion === 2 ? {protocolVersion, preparedProfiles: settings.preparation?.startupProfiles ?? LOCAL_VOICE_KEYS,
      referenceHashes: Object.fromEntries(Object.entries(settings.voices).filter(([, value]) => !value.status || value.status === 'ready')
        .map(([key, value]) => [key, value.sha256])),
      transcriptHashes: Object.fromEntries(Object.entries(settings.voices).filter(([, value]) => !value.status || value.status === 'ready')
        .map(([key, value]) => [key, createHash('sha256').update(value.transcript, 'utf8').digest('hex')]))} : {}), device: 'cuda:0',
    dtype: 'torch.float16', runtime: 'pytorch', tensorrt: false, compiled: false,
    cudaAllocatedMiB: 1800, cudaReservedMiB: 2208, ...readyFields, ...extra});
  const client = new ResidentVoice(settings, {project: process.cwd(), configPath: 'local-config.json',
    pythonExecutable, ...workerOptions,
    ...(timers ? {setTimer: timers.set, clearTimer: timers.clear} : {}),
    onState: state => states.push(state), spawnImpl: (exe, args, options) => {
      starts++; launches.push({exe, args, options});
      assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      if (autoReady) queueMicrotask(() => ready()); return child;
    }});
  const finish = code => child.emit('close', code ?? 0);
  const reply = (index, extra = {}) => {
    const request = requests[index]; assert.ok(request);
    send({...request, op: request.op === 'prepare' ? 'prepared' : 'audio',
      ...(protocolVersion === 2 ? {preparedProfiles: [...new Set([...client.prepared, request.profile])]
        .slice(-client.registry.preparation.maxCachedProfiles)} : {}),
      audio: silentWav().toString('base64'), generationMs: 1400, ...extra});
  };
  return {client, child, states, requests, ready, reply, finish, send, launches, starts: () => starts};
}

function clock() {
  const jobs = new Map(); let time = 0, sequence = 0;
  return {set: (callback, delay) => { const id = ++sequence; jobs.set(id, {callback, at: time + delay}); return id; },
    clear: id => jobs.delete(id), size: () => jobs.size,
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        jobs.delete(next[0]); time = next[1].at; next[1].callback();
      }
      time = target;
    }};
}

test('configured legacy references use local speech; absent or malformed references never borrow a voice', async () => {
  const off = new ResidentVoice({}, {spawnImpl() { throw Error('must not start'); }});
  await off.start(); assert.equal(off.state, 'disabled'); assert.equal(off.usesProfile('judy-alvarez'), false);
  const {client, starts} = harness();
  for (const key of LOCAL_VOICE_KEYS) assert.equal(client.usesProfile(key), true);
  assert.equal(client.usesProfile('alex'), false); assert.equal(client.usesProfile('blue-moon'), false);
  await assert.rejects(client.synthesize('alex', 'Hi'), /Convai voice/);
  assert.equal(starts(), 0);
  assert.throws(() => new ResidentVoice({...config, version: 2, voices: {...config.voices, alex: {}}}), /Invalid local voice reference/);
});

test('packaged Python replaces only the executable and preserves hidden worker ownership', async () => {
  const executable = resolve(process.cwd(), 'relocated 模组 runtime/python/python.exe');
  const h = harness({pythonExecutable: executable});
  await h.client.start();
  assert.equal(h.launches[0].exe, executable);
  assert.deepEqual(h.launches[0].args, [resolve(process.cwd(), 'bridge/resident-voice-worker.py'),
    '--config', 'local-config.json']);
  assert.equal(h.launches[0].options.cwd, process.cwd());
  assert.equal(h.launches[0].options.env.PYTHONUTF8, '1');
  assert.equal(h.launches[0].options.shell, undefined);
  const closed = h.client.close();
  assert.equal(h.child.stdin.writableEnded, true);
  h.finish(); await closed;
  assert.equal(h.client.child, null);
});

test('Python environment override is captured at construction and missing override preserves the development default', async () => {
  const previous = process.env.CYBERPUNK_CONVAI_PYTHON;
  const executable = resolve(process.cwd(), 'packaged python/python.exe');
  let override, development;
  try {
    process.env.CYBERPUNK_CONVAI_PYTHON = executable;
    override = harness();
    delete process.env.CYBERPUNK_CONVAI_PYTHON;
    development = harness();
  } finally {
    if (previous === undefined) delete process.env.CYBERPUNK_CONVAI_PYTHON;
    else process.env.CYBERPUNK_CONVAI_PYTHON = previous;
  }
  for (const [h, expected] of [[override, executable], [development,
    resolve(process.cwd(), 'vendor/reference-voicestudio/.venv/Scripts/python.exe')]]) {
    await h.client.start(); assert.equal(h.launches[0].exe, expected);
    const closed = h.client.close(); h.finish(); await closed;
  }
});

test('invalid explicit Python paths fail before a worker can spawn', () => {
  let spawned = false;
  for (const value of ['', 'python.exe', '../private/python.exe', null, 4, Symbol('private'),
    resolve(process.cwd(), 'python.exe') + '\n', '"' + resolve(process.cwd(), 'python.exe') + '"',
    ...(process.platform === 'win32' ? ['C:python.exe', '\\python.exe', '\\\\server'] : [])]) {
    assert.throws(() => new ResidentVoice(config, {pythonExecutable: value, spawnImpl() { spawned = true; }}),
      {message: 'CYBERPUNK_CONVAI_PYTHON must be an absolute filesystem path.'});
  }
  assert.equal(spawned, false);
});

function portablePaths() {
  return {modelDirectory: resolve(process.cwd(), 'models/omnivoice'),
    adapterDirectory: resolve(process.cwd(), 'voice/voicestudio/backend'),
    referenceDirectory: resolve(process.cwd(), '../persistent 模组/voice-references'),
    cacheDirectory: resolve(process.cwd(), '../persistent 模组/voice-studio-data')};
}

test('portable asset and data paths are captured once and the worker attests the same layout', async () => {
  const paths = portablePaths();
  const h = harness({protocolVersion: 2, workerOptions: paths,
    readyFields: {workerPaths: {applicationDirectory: process.cwd(), ...paths}}});
  const name = 'CYBERPUNK_CONVAI_OMNI_REFERENCES', previous = process.env[name];
  try {
    process.env[name] = resolve(process.cwd(), 'wrong-reference-root');
    await h.client.start();
  } finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
  assert.equal(h.launches[0].options.env.CYBERPUNK_CONVAI_OMNI_REFERENCES, paths.referenceDirectory);
  assert.equal(h.launches[0].options.env.CYBERPUNK_CONVAI_OMNI_MODEL, paths.modelDirectory);
  assert.equal(h.launches[0].options.env.CYBERPUNK_CONVAI_OMNI_ADAPTER, paths.adapterDirectory);
  assert.equal(h.launches[0].options.env.CYBERPUNK_CONVAI_OMNI_CACHE, paths.cacheDirectory);
  assert.equal(h.launches[0].options.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(h.client.loaded, true);
  const closed = h.client.close(); h.finish(); await closed;
});

test('an incomplete portable layout cannot spawn or silently use development assets', () => {
  let spawned = false;
  assert.throws(() => new ResidentVoice(config, {modelDirectory: portablePaths().modelDirectory,
    spawnImpl() { spawned = true; }}), /paths together/);
  assert.throws(() => new ResidentVoice(config, {...portablePaths(), cacheDirectory: 'data/cache',
    spawnImpl() { spawned = true; }}), /CYBERPUNK_CONVAI_OMNI_CACHE must be an absolute filesystem path/);
  assert.equal(spawned, false);
});

test('a worker with another data root or legacy unattested profiles cannot claim portable readiness', async () => {
  const paths = portablePaths();
  for (const [protocolVersion, replacement] of [[2, {cacheDirectory: resolve(process.cwd(), '../other-cache')}], [1, {}]]) {
    const h = harness({autoReady: false, protocolVersion, workerOptions: paths});
    const failed = assert.rejects(h.client.start(), /portable asset and data paths|warm all profiles/);
    h.ready({workerPaths: {applicationDirectory: process.cwd(), ...paths, ...replacement}});
    await failed;
    assert.equal(h.client.loaded, false);
    h.finish(); await h.client.close();
  }
});

test('one FP16 CUDA worker warms all references, stays resident, and changes steps without reloading', async () => {
  const h = harness({autoReady: false});
  const loaded = h.client.start(); assert.equal(h.client.start(), loaded);
  let resolved = false; loaded.then(() => { resolved = true; });
  await tick(); assert.equal(resolved, false);
  h.ready(); await loaded;
  assert.equal(h.client.loaded, true); assert.equal(h.states.at(-1).dtype, 'torch.float16');
  const first = h.client.synthesize('johnny-silverhand', 'Hey, V.'); await tick();
  assert.equal(h.requests[0].steps, 32); h.reply(0);
  const result = await first;
  assert.deepEqual(Buffer.from(result.audio, 'base64'), silentWav());
  assert.equal(result.timing.voiceWarm, true); assert.equal(result.timing.voiceDtype, 'torch.float16');
  h.client.setSteps(16);
  assert.equal(h.states.at(-1).resident, true); assert.equal(h.states.at(-1).cudaReservedMiB, 2208);
  const second = h.client.synthesize('panam-palmer', 'Ready?'); await tick(); h.reply(1); await second;
  assert.equal(h.requests[1].steps, 16); assert.equal(h.starts(), 1);
  const closed = h.client.close(); h.finish(); await closed;
  assert.equal(h.states.at(-1).resident, false);
});

test('cancelling active speech never overlaps GPU jobs, and cancelled queued work is skipped', async () => {
  const h = harness(); const active = new AbortController(), queued = new AbortController();
  const first = h.client.synthesize('judy-alvarez', 'First', {signal: active.signal});
  await tick(); assert.equal(h.requests.length, 1);
  const second = h.client.synthesize('johnny-silverhand', 'Second', {signal: queued.signal});
  const firstRejected = assert.rejects(first, /cancelled/), secondRejected = assert.rejects(second, /cancelled/);
  active.abort(); queued.abort(); await firstRejected; await secondRejected;
  h.client.setSteps(16);
  const third = h.client.synthesize('panam-palmer', 'Third'); await tick();
  assert.equal(h.requests.length, 1);
  h.reply(0); await tick(); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].text, 'Third'); assert.equal(h.requests[1].steps, 16);
  h.reply(1); await third;
  const closed = h.client.close(); h.finish(); await closed;
});

test('shutdown waits for the worker to finish and drops a late reply', async () => {
  const h = harness(); const audio = h.client.synthesize('judy-alvarez', 'In progress'); await tick();
  const rejected = assert.rejects(audio, /cancelled/);
  let stopped = false; const closed = h.client.close().then(() => { stopped = true; });
  assert.equal(h.child.stdin.writableEnded, true); await tick(); assert.equal(stopped, false);
  h.reply(0); await rejected;
  h.finish(); await closed; assert.equal(stopped, true);
  await assert.rejects(h.client.synthesize('panam-palmer', 'Too late'), /cancelled/);
});

test('worker loss rejects waiting speech and reports that GPU residency ended', async () => {
  const h = harness(); const first = h.client.synthesize('judy-alvarez', 'First'); await tick();
  const second = h.client.synthesize('panam-palmer', 'Second');
  const rejected = Promise.all([assert.rejects(first, /exited/), assert.rejects(second, /exited/)]);
  h.finish(1); await rejected;
  assert.equal(h.states.at(-1).state, 'error'); assert.equal(h.states.at(-1).resident, false);
  assert.equal(h.requests.length, 1);
});

test('all phrases retain their utterance quality if the user changes the next-reply setting', async () => {
  const h = harness(); h.client.setSteps(16);
  const phrase = h.client.synthesize('judy-alvarez', 'Still part of the 32-step reply.', {steps: 32});
  await tick(); assert.equal(h.requests[0].steps, 32); h.reply(0); await phrase;
  const next = h.client.synthesize('judy-alvarez', 'A new reply.');
  await tick(); assert.equal(h.requests[1].steps, 16); h.reply(1); await next;
  const closed = h.client.close(); h.finish(); await closed;
});

test('wrong device/precision cannot report readiness; wrong speaker and malformed audio cannot play', async () => {
  const bad = harness({autoReady: false}); const failed = assert.rejects(bad.client.start(), /did not warm/);
  bad.ready({dtype: 'torch.float32'}); await failed; bad.finish(1);
  const h = harness();
  const first = h.client.synthesize('judy-alvarez', 'First'); await tick();
  const rejected = assert.rejects(first, /identity changed/); h.reply(0, {profile: 'panam-palmer'}); await rejected;
  const second = h.client.synthesize('judy-alvarez', 'Second'); await tick();
  const invalid = assert.rejects(second, /supported WAV/); h.reply(1, {audio: Buffer.from('{}').toString('base64')}); await invalid;
  const closed = h.client.close(); h.finish(); await closed;
});

test('acceleration diagnostics distinguish replay from a bounded eager fallback without changing quality', async () => {
  const h = harness();
  const first = h.client.synthesize('judy-alvarez', 'A cached render.'); await tick();
  h.reply(0, {acceleration: 'cuda-graph', cudaGraph: {replays: 32, captures: 1, graphReservedMiB: 44}});
  const replay = await first;
  assert.equal(replay.timing.voiceAcceleration, 'cuda-graph');
  assert.equal(replay.timing.voiceGraph.replays, 32);
  assert.equal(replay.timing.voiceSteps, 32);
  const next = h.client.synthesize('judy-alvarez', 'A shape above the graph budget.'); await tick();
  h.reply(1, {acceleration: 'eager', cudaGraph: {replays: 32, fallbacks: 32, shape: null}});
  const fallback = await next;
  assert.equal(fallback.timing.voiceAcceleration, 'eager');
  assert.equal(h.states.at(-1).cudaGraph.shape, null);
  assert.deepEqual(fallback.audio, replay.audio);
  const closed = h.client.close(); h.finish(); await closed;
});

test('an intentional shutdown rejects an unfinished render if the child exits without an audio frame', async () => {
  const h = harness(); const audio = h.client.synthesize('judy-alvarez', 'In progress'); await tick();
  const rejected = assert.rejects(audio, /stopped|cancelled/);
  const closed = h.client.close(); h.finish(1); await closed; await rejected;
  assert.equal(h.client.pending.size, 0); assert.equal(h.client.loaded, false);
});

test('startup timeout releases callers then bounds owned-worker retirement without overlapping a replacement', async () => {
  const timers = clock(), h = harness({autoReady: false, timers});
  const ready = assert.rejects(h.client.start(), /startup timed out/);
  timers.advance(VOICE_WORKER_LIMITS.startupMs - 1); assert.equal(h.child.stdin.writableEnded, false);
  timers.advance(1); await ready; assert.equal(h.child.stdin.writableEnded, true);
  assert.equal(h.child.kills, 0);
  const closed = h.client.close();
  timers.advance(VOICE_WORKER_LIMITS.exitGraceMs - 1); assert.equal(h.child.kills, 0);
  timers.advance(1); assert.equal(h.child.kills, 1);
  h.finish(); await closed; assert.equal(timers.size(), 0);
  await assert.rejects(h.client.start(), /stopping/); assert.equal(h.starts(), 1);
});

test('render timeout rejects queued work and discards a late WAV while waiting for physical exit', async () => {
  const timers = clock(), h = harness({timers});
  const first = h.client.synthesize('judy-alvarez', 'First'); await tick();
  const second = h.client.synthesize('panam-palmer', 'Queued');
  const rejected = Promise.all([assert.rejects(first, /generation timed out/), assert.rejects(second, /generation timed out/)]);
  timers.advance(VOICE_WORKER_LIMITS.renderMs); await rejected;
  assert.equal(h.requests.length, 1); assert.equal(h.client.pending.size, 0);
  h.reply(0); assert.equal(h.client.state, 'error');
  const closed = h.client.close(); h.finish(); await closed;
  assert.equal(timers.size(), 0); assert.equal(h.child.kills, 0);
});

test('ordinary close lets an active render finish within its original limit and only then starts teardown allowance', async () => {
  const timers = clock(), h = harness({timers});
  const first = h.client.synthesize('judy-alvarez', 'First'); await tick();
  const rejected = assert.rejects(first, /cancelled/), closed = h.client.close();
  timers.advance(VOICE_WORKER_LIMITS.renderMs - 1); assert.equal(h.child.kills, 0);
  h.reply(0); await rejected;
  timers.advance(VOICE_WORKER_LIMITS.exitGraceMs - 1); assert.equal(h.child.kills, 0);
  h.finish(); await closed; assert.equal(timers.size(), 0);
});

test('missing process-exit confirmation rejects close rather than claiming CUDA was released', async () => {
  const timers = clock(), h = harness({timers}); await h.client.start();
  const closed = assert.rejects(h.client.close(), /exit could not be confirmed/);
  timers.advance(VOICE_WORKER_LIMITS.exitGraceMs + VOICE_WORKER_LIMITS.exitConfirmationMs);
  await closed; assert.equal(h.child.kills, 1); assert.equal(h.client.loaded, true);
  assert.equal(h.client.child, h.child); assert.equal(h.client.state, 'error');
  assert.equal(timers.size(), 0); h.finish();
});

const widerConfig = (extra = {}) => ({...config, version: 2,
  voices: {...config.voices, ...Object.fromEntries(['alex', 'blue-moon', 'iris', 'river-ward', 'kerry-eurodyne', 'rogue-amendiares']
    .map(key => [key, {reference: `runtime/voice-references/${key}.wav`, sha256: 'b'.repeat(64), transcript: 'Hello, V.'}])),
    unavailable: {status: 'unavailable'}, unprepared: {status: 'unprepared'}},
  preparation: {mode: 'lazy', startupProfiles: LOCAL_VOICE_KEYS, maxCachedProfiles: 8}, ...extra});

test('v2 widens configured voices without warming the cast at startup; Invite prepares just one profile', async () => {
  const h = harness({settings: widerConfig(), protocolVersion: 2});
  await h.client.start();
  assert.equal(h.client.usesProfile('alex'), true);
  assert.equal(h.client.profileReady('alex'), false);
  assert.deepEqual([...h.client.prepared].sort(), [...LOCAL_VOICE_KEYS].sort());
  for (const key of ['unavailable', 'unprepared', 'not-registered']) {
    assert.equal(h.client.usesProfile(key), false);
    assert.deepEqual(await h.client.prepareProfile(key), {provider: 'convai', ready: true,
      reason: key === 'not-registered' ? 'missing' : key});
  }
  const prepared = h.client.prepareProfile('alex'); await tick();
  assert.deepEqual(h.requests[0], {op: 'prepare', id: 1, profile: 'alex'});
  assert.equal(h.states.at(-1).state, 'warming'); h.reply(0);
  assert.deepEqual(await prepared, {provider: 'omnivoice', ready: true, profile: 'alex'});
  await h.client.prepareProfile('alex'); assert.equal(h.requests.length, 1);
  const audio = h.client.synthesize('alex', 'A new speaker.'); await tick();
  assert.equal(h.requests[1].op, 'synthesize'); assert.equal(h.requests[1].steps, 32);
  h.reply(1); await audio;
  assert.equal(h.starts(), 1);
  const closed = h.client.close(); h.finish(); await closed;
});

test('prepare/render share physical ownership, with immediate caller cancellation and no GPU overlap', async () => {
  const h = harness({settings: widerConfig(), protocolVersion: 2}), controller = new AbortController();
  const first = h.client.prepareProfile('alex', {signal: controller.signal}); await tick();
  const rejected = assert.rejects(first, /cancelled/); controller.abort(); await rejected;
  const next = h.client.synthesize('blue-moon', 'Next speaker.'); await tick();
  assert.equal(h.requests.length, 1, 'cancelled physical preparation still owns GPU');
  h.reply(0); await tick();
  assert.equal(h.requests[1].op, 'prepare'); assert.equal(h.requests[1].profile, 'blue-moon');
  h.reply(1); await tick();
  assert.equal(h.requests[2].op, 'synthesize'); h.reply(2); await next;
  const closed = h.client.close(); h.finish(); await closed;
});

test('preparation cancellation before execution skips work, while eviction requires a fresh preparation', async () => {
  const h = harness({settings: widerConfig(), protocolVersion: 2}), queued = new AbortController();
  const first = h.client.prepareProfile('alex'); await tick();
  const second = h.client.prepareProfile('blue-moon', {signal: queued.signal});
  const rejected = assert.rejects(second, /cancelled/); queued.abort(); await rejected;
  h.reply(0); await first; await tick(); assert.equal(h.requests.length, 1);
  const third = h.client.synthesize('iris', 'Replace oldest cached prompt.'); await tick();
  h.reply(1, {preparedProfiles: ['iris']}); await tick();
  assert.equal(h.client.profileReady('alex'), false);
  h.reply(2, {preparedProfiles: ['iris']}); await third;
  const prepared = h.client.prepareProfile('alex'); await tick();
  assert.equal(h.requests[3].op, 'prepare'); h.reply(3); await prepared;
  const closed = h.client.close(); h.finish(); await closed;
});

test('missing ready reference is an explicit remote route before any dialogue is submitted', async () => {
  const h = harness({settings: widerConfig(), protocolVersion: 2, autoReady: false});
  const starting = h.client.start();
  const profiles = Object.keys(config.voices);
  h.ready({profiles, preparedProfiles: profiles,
    referenceHashes: Object.fromEntries(profiles.map(key => [key, config.voices[key].sha256])),
    transcriptHashes: Object.fromEntries(profiles.map(key => [key, createHash('sha256').update(config.voices[key].transcript).digest('hex')]))});
  await starting;
  assert.equal(h.client.usesProfile('alex'), false);
  const ready = await h.client.prepareProfile('alex');
  assert.equal(ready.provider, 'convai'); assert.equal(h.requests.length, 0);
  const closed = h.client.close(); h.finish(); await closed;
});

test('lazy registry rejects a legacy worker, unverified hashes and duplicate/foreign readiness entries', async () => {
  for (const [protocolVersion, extra] of [[1, {}], [2, {referenceHashes: {}}], [2, {transcriptHashes: {}}],
    [2, {preparedProfiles: ['alex', 'alex']}], [2, {profiles: ['not-configured'], preparedProfiles: []}]]) {
    const h = harness({settings: widerConfig(), protocolVersion, autoReady: false});
    const failed = assert.rejects(h.client.start(), /did not warm/);
    h.ready(extra); await failed; assert.equal(h.child.stdin.writableEnded, true); h.finish(1);
  }
});

test('prepared identity/cache attestations must match the caller and cannot overrun the bounded cache', async () => {
  for (const extra of [{profile: 'iris'}, {preparedProfiles: ['iris']},
    {preparedProfiles: ['alex', 'alex']}, {preparedProfiles: [...Object.keys(widerConfig().voices)].filter(key => !['unavailable', 'unprepared'].includes(key))}]) {
    const h = harness({settings: widerConfig(), protocolVersion: 2});
    const first = h.client.prepareProfile('alex'); await tick();
    const rejected = assert.rejects(first, /identity changed|Invalid prepared/); h.reply(0, extra); await rejected;
    const closed = h.client.close(); h.finish(); await closed;
  }
});

test('preparation failure never synthesizes dialogue or borrows another voice, and can be retried locally', async () => {
  const h = harness({settings: widerConfig(), protocolVersion: 2});
  const first = h.client.prepareProfile('alex'); await tick();
  const failed = assert.rejects(first, /could not prepare/);
  h.send({op: 'error', id: h.requests[0].id}); await failed;
  assert.equal(h.client.profileReady('alex'), false); assert.equal(h.requests.length, 1);
  const retry = h.client.prepareProfile('alex'); await tick(); h.reply(1); await retry;
  assert.equal(h.starts(), 1);
  const closed = h.client.close(); h.finish(); await closed;
});

test('preparation timeout/close keeps the same bounded process retirement and discards late preparation', async () => {
  const timers = clock(), h = harness({settings: widerConfig(), protocolVersion: 2, timers});
  const first = h.client.prepareProfile('alex'); await tick();
  const rejected = assert.rejects(first, /preparation timed out/);
  timers.advance(VOICE_WORKER_LIMITS.renderMs); await rejected;
  h.reply(0); assert.equal(h.client.state, 'error'); assert.equal(h.client.profileReady('alex'), false);
  const closed = h.client.close(); timers.advance(VOICE_WORKER_LIMITS.exitGraceMs);
  assert.equal(h.child.kills, 1); h.finish(); await closed;
  assert.equal(h.client.loaded, false); assert.equal(timers.size(), 0);
});

test('Keep prepared voices makes the join-time warm-up use the selected steps; off keeps the original request', async () => {
  const off = harness({settings: widerConfig(), protocolVersion: 2});
  await off.client.start(); off.client.setSteps(16);
  const first = off.client.prepareProfile('alex'); await tick();
  assert.deepEqual(off.requests[0], {op: 'prepare', id: 1, profile: 'alex'});
  off.reply(0); await first;
  const closedOff = off.client.close(); off.finish(); await closedOff;
  const on = harness({settings: widerConfig(), protocolVersion: 2});
  await on.client.start(); on.client.setSteps(16); on.client.setKeepPrepared(true);
  const prepared = on.client.prepareProfile('alex'); await tick();
  assert.deepEqual(on.requests[0], {op: 'prepare', id: 1, profile: 'alex', steps: 16});
  on.reply(0); await prepared;
  on.client.setSteps(32);
  const second = on.client.prepareProfile('iris'); await tick();
  assert.deepEqual(on.requests[1], {op: 'prepare', id: 2, profile: 'iris', steps: 32});
  on.reply(1); await second;
  on.client.setKeepPrepared(false);
  const third = on.client.prepareProfile('river-ward'); await tick();
  assert.deepEqual(on.requests[2], {op: 'prepare', id: 3, profile: 'river-ward'});
  on.reply(2); await third;
  const closed = on.client.close(); on.finish(); await closed;
});
