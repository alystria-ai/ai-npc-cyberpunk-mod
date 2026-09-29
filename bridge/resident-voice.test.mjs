import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {ResidentVoice, LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {silentWav} from './speech-audio.mjs';

const config = {provider: 'hybrid', engine: 'omnivoice',
  voices: Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {reference: key}]))};
const tick = () => new Promise(done => setImmediate(done));
function harness({autoReady = true} = {}) {
  const states = [], requests = []; let starts = 0;
  const child = new EventEmitter();
  child.pid = 1234; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({write(chunk, encoding, done) {
    requests.push(JSON.parse(chunk.toString())); done();
  }});
  const send = frame => child.stdout.write(JSON.stringify(frame) + '\n');
  const ready = (extra = {}) => send({op: 'ready', profiles: LOCAL_VOICE_KEYS, device: 'cuda:0',
    dtype: 'torch.float16', runtime: 'pytorch', tensorrt: false, compiled: false,
    cudaAllocatedMiB: 1800, cudaReservedMiB: 2208, ...extra});
  const client = new ResidentVoice(config, {project: process.cwd(), configPath: 'local-config.json',
    onState: state => states.push(state), spawnImpl: (exe, args, options) => {
      starts++; assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      if (autoReady) queueMicrotask(() => ready()); return child;
    }});
  const finish = code => child.emit('close', code ?? 0);
  const reply = (index, extra = {}) => {
    const request = requests[index]; assert.ok(request);
    send({...request, op: 'audio', audio: silentWav().toString('base64'), generationMs: 1400, ...extra});
  };
  return {client, child, states, requests, ready, reply, finish, starts: () => starts};
}

test('only Johnny, Judy and Panam use local speech; an absent configuration preserves Convai', async () => {
  const off = new ResidentVoice({}, {spawnImpl() { throw Error('must not start'); }});
  await off.start(); assert.equal(off.state, 'disabled'); assert.equal(off.usesProfile('judy-alvarez'), false);
  const {client, starts} = harness();
  for (const key of LOCAL_VOICE_KEYS) assert.equal(client.usesProfile(key), true);
  assert.equal(client.usesProfile('alex'), false); assert.equal(client.usesProfile('blue-moon'), false);
  await assert.rejects(client.synthesize('alex', 'Hi'), /Convai voice/);
  assert.equal(starts(), 0);
  assert.throws(() => new ResidentVoice({...config, voices: {...config.voices, alex: {}}}), /must map/);
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
