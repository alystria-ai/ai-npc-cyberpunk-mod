import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {silentWav} from './speech-audio.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';

// Execute the production routing/publication functions. These checks catch a
// future shared batching path accidentally processing remote Convai speech.
const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const code = section('async function synthesizeReply(', 'async function synthesizePhrase(')
  + section('function continuousSpeech(', 'async function respond(')
  + section('async function respond(', 'const micPath =');
function fixture({local = false, available = true, audioFailure = false, continuous = false, voiceSelection} = {}) {
  const calls = [], publications = [];
  const remote = {text: 'A complete reply. With two sentences.', sessionID: 'test-session',
    audio: silentWav().toString('base64'), faces: [{at: 0, values: [0.2]}],
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds', timing: {audioRoute: 'convai-data-only'}};
  const selectedVoice = voiceSelection ?? {usesProfile: () => local, steps: 32};
  const sandbox = {remote, calls, publications, runtime: 'test-runtime', replyPath: 'reply.json',
    localVoice: selectedVoice,
    splitSpeechText: text => { calls.push('split'); return ['A complete reply.', 'With two sentences.']; },
    synthesizePhrase: async (profile, text) => { calls.push('local:' + text); return {audio: 'local-wav', timing: {voiceProvider: 'omni'}}; },
    throwIfCancelled: () => {}, audioReady: async () => available,
    readSpeechState: async () => ({continuousAvailable: continuous}),
    readFile: async () => '{}', preparedInputs: new WeakMap(),
    ConvaiContinuousSpeech: class {
      constructor(options) { this.callbacks = options; this.published = true; this.ended = true; this.generated = true; this.token = 'continuous-owner';
        this.options = {token: this.token, onFrame: () => calls.push('live-frame')}; }
      async fail() { calls.push('live-failed'); }
    },
    realtimeConfig: input => ({profileKey: input.profileKey, text: input.text, ttsEnabled: !selectedVoice.usesProfile(input.profileKey)}),
    realtime: {reply: async (config, options) => {
      calls.push(['send', config]);
      if (options?.liveSpeech) {
        await options.liveSpeech.onFrame();
        return {...remote, audio: undefined, continuous: true};
      }
      return config.ttsEnabled ? remote : {...remote, audio: undefined};
    }},
    prefetch: {invalidate() {}, published: () => calls.push('prefetch-published')},
    slots: {begin: async () => calls.push('begin-slot'), write: async (id, index, bytes) => {
      calls.push(['write-slot', index, bytes]); if (audioFailure) throw Error('Fake disk error');
      return {event: 'convai_reply_0', duration: 0.1};
    }},
    SpeechStream: class {constructor() { throw Error('Remote route must not create a phrase stream'); }},
    randomUUID: () => 'slot-owner', buildFacialTimeline: result => { assert.equal(result.faces, remote.faces); return {source: 'convai-arkit61'}; },
    atomic: async (path, value) => { publications.push([path, JSON.parse(value)]); return true; },
    resolve: (...parts) => parts.join('/'), sessionKey: () => 'exact-session',
    realtimeSessions: new Map(), sessions: new Map(), connections: {used: () => calls.push('used')},
    measure: async () => {}, status: async () => {}, Date, console: {error() {}},
    knowledgeRouter: {activity: async (prepared, event, detail) => calls.push(['knowledge', prepared, event, detail])},
    stagedKnowledgeTurn: prepared => calls.push(['staged', prepared]),
  };
  runInNewContext(code + ';globalThis.api={respond,publishResult,continuousSpeech};', sandbox);
  return {...sandbox, input: {requestId: 'r1', generation: 1, entity: 'e1', profileKey: 'judy', text: 'Hello'},
    profile: {key: 'judy', name: 'Judy'}};
}

test('continuous microphone receipt stays on the original submitted owner after context refresh', async () => {
  const f = fixture(), original = {input: {...f.input}, guard: 'original'}, refreshed = {input: f.input, guard: 'refreshed'};
  f.preparedInputs.set(f.input, refreshed);
  const speech = f.api.continuousSpeech(f.input, f.profile, async () => true, undefined, original);
  await speech.callbacks.onGenerated('Reply heard by V');
  const activity = f.calls.find(value => value[0] === 'knowledge');
  assert.equal(activity[1], original); assert.equal(activity[2], 'generated-reply');
  assert.equal(f.calls.find(value => value[0] === 'staged')[1], original);
});

test('continuous generation cannot report staging when its submitted receipt is missing', async () => {
  const f = fixture();
  const speech = f.api.continuousSpeech(f.input, f.profile, async () => true);
  await assert.rejects(speech.callbacks.onGenerated('Reply'), /receipt owner changed/);
  assert.ok(!f.calls.some(value => value[0] === 'knowledge' || value[0] === 'staged'));
});

test('Convai sends once, preserves provider data and publishes one native WAV without text batching', async () => {
  const f = fixture(), current = async () => true;
  const result = await f.api.respond(f.input, f.profile, {current});
  assert.equal(result.audio, f.remote.audio); assert.equal(result.faces, f.remote.faces);
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'send').length, 1);
  assert.ok(!f.calls.includes('split'));
  assert.equal(result.streamPlan, undefined);
  await f.api.publishResult(f.input, f.profile, result, current);
  assert.deepEqual(f.calls.filter(x => Array.isArray(x) && x[0] === 'write-slot'), [['write-slot', 1, f.remote.audio]]);
  const reply = f.publications.find(([path]) => path === 'reply.json')[1];
  assert.equal(reply.text, f.remote.text); assert.equal(reply.stream, undefined);
  assert.equal(reply.face.source, 'convai-arkit61');
});

test('only local voice splits text, with remote TTS disabled and fixed quality for the remaining phrases', async () => {
  const f = fixture({local: true});
  const result = await f.api.respond(f.input, f.profile);
  assert.equal(f.calls[0][1].ttsEnabled, false);
  assert.equal(f.calls.filter(x => x === 'split').length, 1);
  assert.equal(f.calls.filter(x => typeof x === 'string' && x.startsWith('local:')).length, 1);
  assert.equal(result.streamPlan.steps, 32);
  assert.equal(result.streamPlan.phrases.length, 2);
});

test('unavailable native audio uses one identified text turn without a second synthesis request', async () => {
  const f = fixture({available: false});
  const result = await f.api.respond(f.input, f.profile);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].ttsEnabled, false);
  assert.equal(result.audio, undefined);
});

test('failed native audio preparation preserves the complete text without retrying the provider', async () => {
  const f = fixture({audioFailure: true});
  const result = await f.api.respond(f.input, f.profile);
  await f.api.publishResult(f.input, f.profile, result);
  const reply = f.publications.find(([path]) => path === 'reply.json')[1];
  assert.equal(reply.text, f.remote.text); assert.equal(reply.audio, undefined);
  assert.match(reply.audioError, /written reply/);
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'send').length, 1);
});

test('loaded Convai streaming controller bypasses Omni batching and completed-WAV publication', async () => {
  const f = fixture({continuous: true}), current = async () => true;
  const result = await f.api.respond(f.input, f.profile, {current});
  assert.equal(result.continuous, true); assert.equal(result.liveDelivery.ended, true);
  assert.equal(f.calls.filter(x => x === 'live-frame').length, 1);
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'send').length, 1);
  assert.ok(!f.calls.includes('split')); assert.equal(result.streamPlan, undefined);
  assert.equal(await f.api.publishResult(f.input, f.profile, result, current), true);
  assert.ok(!f.calls.includes('begin-slot'));
  assert.equal(f.publications.length, 0, 'no second reply or native WAV replaces the live admission');
  assert.equal(f.realtimeSessions.get('exact-session'), 'test-session');
});

test('Omni remains on its own phrase route when the continuous Convai controller is available', async () => {
  const f = fixture({local: true, continuous: true});
  const result = await f.api.respond(f.input, f.profile);
  assert.equal(f.calls[0][1].ttsEnabled, false);
  assert.ok(f.calls.includes('split')); assert.ok(!f.calls.includes('live-frame'));
  assert.equal(result.continuous, undefined); assert.equal(result.streamPlan.steps, 32);
});

test('continuous provider completion without game playback drain cannot be called delivered', async () => {
  const f = fixture({continuous: true}), current = async () => true;
  const result = await f.api.respond(f.input, f.profile, {current});
  await assert.rejects(f.api.publishResult(f.input, f.profile,
    {...result, liveDelivery: {...result.liveDelivery, ended: false}}, current), /did not finish/);
  assert.equal(f.publications.length, 0); assert.equal(f.realtimeSessions.size, 0);
});

test('the validated wider registry selects Omni only for the matching reference; unprepared cast stays continuous Convai', async () => {
  const voices = new VoiceSelection({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: {
    alex: {reference: 'runtime/voice-references/alex.wav', sha256: 'a'.repeat(64), transcript: 'Hello.'},
    'blue-moon': {status: 'unprepared'},
  }}, {factory() { throw Error('routing checks must not run GPU inference'); }});
  const local = fixture({voiceSelection: voices, continuous: true});
  local.input.profileKey = 'alex'; local.profile.key = 'alex';
  const reply = await local.api.respond(local.input, local.profile);
  assert.equal(local.calls[0][1].ttsEnabled, false);
  assert.equal(reply.streamPlan.steps, 32); assert.equal(local.calls.includes('live-frame'), false);

  const remote = fixture({voiceSelection: voices, continuous: true});
  remote.input.profileKey = 'blue-moon'; remote.profile.key = 'blue-moon';
  const response = await remote.api.respond(remote.input, remote.profile, {current: async () => true});
  assert.equal(remote.calls.find(value => Array.isArray(value) && value[0] === 'send')[1].ttsEnabled, true);
  assert.equal(response.continuous, true); assert.equal(remote.calls.includes('split'), false);
  assert.equal(response.streamPlan, undefined);
  assert.equal(remote.calls.filter(value => Array.isArray(value) && value[0] === 'send').length, 1);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {resolve, promise}; };
function invitationVoiceFixture({reconfigure = async () => {}, prepare} = {}) {
  const changes = [], calls = [], local = new Set(['alex']);
  const localVoice = {routeRevision: 0, consumeRouteChanges: () => changes.splice(0),
    usesProfile: profile => local.has(profile), profileReady: profile => local.has(profile),
    prepareProfile: async (profile, options) => {
      calls.push(['prepare', profile]);
      return prepare ? prepare(profile, options) : local.has(profile)
        ? {provider: 'omnivoice', ready: true, profile} : {provider: 'convai', ready: true, reason: 'selected'};
    }};
  const sandbox = {localVoice, abortable, throwIfCancelled, stopped: false, active: null, streaming: 0,
    polling: false, micPolling: false, mic: {current: null}, prefetchPolling: false, memoryQuiescing: 0,
    connections: {reconfigure: async keys => { calls.push(['reconfigure', [...keys]]); return reconfigure(keys); }}};
  runInNewContext(section('let voiceRouteSync =', 'const invitations =')
    + section('async function pollMicrophone(', 'async function tick(')
    + section('async function tick(', 'async function pollPrefetch(')
    + ';globalThis.api={syncVoiceRoutes,prepareInvitedVoice,voiceBoundaryBusy,invitedVoiceCurrent,tick,pollMicrophone,'
    + 'reserved:()=>voiceRouteReservation,queued:()=>voiceRoutePending.size,waiters:()=>voiceRouteWaiters.size};', sandbox);
  return {...sandbox, context: sandbox, local, changes, calls, mark(keys) { localVoice.routeRevision++; changes.push(...keys); }};
}

test('voice preparation holds Invite readiness until the affected connection pages are reconciled', async () => {
  const held = deferred(), f = invitationVoiceFixture({reconfigure: () => held.promise});
  f.mark(['alex']); let ready = false;
  const preparation = f.api.prepareInvitedVoice('alex').then(receipt => { ready = true; return receipt; });
  await turn(); assert.equal(ready, false);
  assert.deepEqual(f.calls, [['prepare', 'alex'], ['reconfigure', ['alex']]]);
  held.resolve(); const receipt = await preparation;
  assert.equal(receipt.provider, 'omnivoice'); assert.equal(receipt.profile, 'alex'); assert.equal(receipt.ready, true);
});

test('a newer route revision is retained while an older page reconciliation finishes', async () => {
  const held = deferred(); let count = 0;
  const f = invitationVoiceFixture({reconfigure: () => ++count === 1 ? held.promise : Promise.resolve()});
  f.mark(['alex']); const first = f.api.syncVoiceRoutes(); await turn();
  f.mark(['alex', 'judy-alvarez']); const second = f.api.syncVoiceRoutes();
  held.resolve(); await first; await second;
  assert.deepEqual(f.calls, [['reconfigure', ['alex']], ['reconfigure', ['alex', 'judy-alvarez']]]);
});

test('failed page reconciliation keeps dynamic affected keys for retry and never submits dialogue', async () => {
  let failed = false;
  const f = invitationVoiceFixture({reconfigure: async () => { if (!failed) { failed = true; throw Error('temporary page failure'); } }});
  f.mark(['alex']); await assert.rejects(f.api.syncVoiceRoutes(), /temporary page failure/);
  await f.api.syncVoiceRoutes();
  assert.deepEqual(f.calls, [['reconfigure', ['alex']], ['reconfigure', ['alex']]]);
});

test('Invite rechecks provider after page retirement without publishing a stale local-ready receipt', async () => {
  const held = deferred(), f = invitationVoiceFixture({reconfigure: () => held.promise});
  f.mark(['alex']); const preparation = f.api.prepareInvitedVoice('alex'); await turn();
  f.local.delete('alex'); f.mark(['alex']); held.resolve();
  const receipt = await preparation;
  assert.equal(receipt.provider, 'convai'); assert.equal(receipt.ready, true);
  assert.equal(f.calls.filter(call => call[0] === 'prepare').length, 2);
});

test('cancelling Invite releases its caller while the shared connection reconciliation remains serialized', async () => {
  const held = deferred(), f = invitationVoiceFixture({reconfigure: () => held.promise}), controller = new AbortController();
  f.mark(['alex']); const preparation = f.api.prepareInvitedVoice('alex', {signal: controller.signal}); await turn();
  const rejected = assert.rejects(preparation, /cancelled/); controller.abort(); await rejected;
  held.resolve(); await f.api.syncVoiceRoutes();
  assert.equal(f.calls.filter(call => call[0] === 'prepare').length, 1);
});

test('invalid preparation receipts and bridge shutdown cannot authorize a spawn connection', async () => {
  for (const receipt of [undefined, {provider: 'omnivoice', ready: false, profile: 'alex'},
    {provider: 'omnivoice', ready: true, profile: 'judy-alvarez'}, {provider: 'other', ready: true}]) {
    const f = invitationVoiceFixture({prepare: async () => receipt});
    await assert.rejects(f.api.prepareInvitedVoice('alex'), /readiness could not be verified/);
    assert.equal(f.calls.filter(call => call[0] === 'reconfigure').length, 0);
  }
  const f = invitationVoiceFixture(); f.context.stopped = true;
  await assert.rejects(f.api.prepareInvitedVoice('alex'), /closed/);
});

test('the routing boundary includes text, phrase, microphone and input/context ownership', () => {
  const f = invitationVoiceFixture();
  assert.equal(f.api.voiceBoundaryBusy(), false);
  for (const key of ['active', 'streaming', 'polling', 'micPolling', 'prefetchPolling', 'memoryQuiescing']) {
    const previous = f.context[key]; f.context[key] = true;
    assert.equal(f.api.voiceBoundaryBusy(), true, key); f.context[key] = previous;
  }
  f.context.mic.current = {}; assert.equal(f.api.voiceBoundaryBusy(), true);
  f.context.mic.current = null; assert.equal(f.api.voiceBoundaryBusy(), false);
});

test('a failed idle reconciliation defers retry throughout a new active turn and releases Invite on the next idle poll', async () => {
  let first = true;
  const f = invitationVoiceFixture({reconfigure: async () => { if (first) { first = false; throw Error('page unavailable'); } }});
  f.mark(['alex']); await assert.rejects(f.api.syncVoiceRoutes(), /page unavailable/);
  f.context.active = {input: {profileKey: 'alex'}};
  await f.api.syncVoiceRoutes(); assert.equal(f.calls.length, 1, 'active turn prevents the retry from touching its page');
  let ready = false;
  const preparation = f.api.prepareInvitedVoice('alex').then(value => { ready = true; return value; });
  await turn(); assert.equal(ready, false); assert.equal(f.api.waiters(), 1);
  assert.equal(f.calls.filter(call => call[0] === 'reconfigure').length, 1);
  f.context.active = null; await f.api.syncVoiceRoutes();
  assert.equal((await preparation).provider, 'omnivoice'); assert.equal(f.api.queued(), 0);
  assert.equal(f.api.reserved(), false); assert.equal(f.api.waiters(), 0);
});

test('the synchronous routing reservation blocks actual text and microphone entry functions until page settlement', async () => {
  const held = deferred(), f = invitationVoiceFixture({reconfigure: () => held.promise});
  f.mark(['alex']); const sync = f.api.syncVoiceRoutes();
  assert.equal(f.api.reserved(), true, 'reservation exists before the first asynchronous page callback');
  // Execute the production entry functions with no filesystem/provider mocks.
  // If they pass the admission guard they will fail on their first native IO.
  await f.api.tick(); await f.api.pollMicrophone();
  assert.equal(f.context.polling, false); assert.equal(f.context.micPolling, false);
  held.resolve(); await sync; assert.equal(f.api.reserved(), false);
});

test('cancelling a busy Invite removes its deferred page waiter while keeping the global retry', async () => {
  const f = invitationVoiceFixture(), controller = new AbortController();
  f.context.active = {}; f.mark(['alex']);
  const preparation = f.api.prepareInvitedVoice('alex', {signal: controller.signal}); await turn();
  assert.equal(f.api.waiters(), 1);
  const rejected = assert.rejects(preparation, /cancelled/); controller.abort(); await rejected;
  assert.equal(f.api.waiters(), 0); assert.equal(f.api.queued(), 1);
  f.context.active = null; await f.api.syncVoiceRoutes();
  assert.equal(f.api.queued(), 0);
});

test('stored Invite voice receipts are invalid during pending selection, page reconciliation or cache eviction', async () => {
  const f = invitationVoiceFixture(), receipt = {provider: 'omnivoice', ready: true, profile: 'alex'};
  assert.equal(f.api.invitedVoiceCurrent('alex', receipt), true);
  f.localVoice.pending = true; assert.equal(f.api.invitedVoiceCurrent('alex', receipt), false);
  f.localVoice.pending = false; f.localVoice.availabilityPending = true;
  assert.equal(f.api.invitedVoiceCurrent('alex', receipt), false); f.localVoice.availabilityPending = false;
  f.localVoice.profileReady = () => false; assert.equal(f.api.invitedVoiceCurrent('alex', receipt), false);
  f.local.delete('alex'); assert.equal(f.api.invitedVoiceCurrent('alex', {provider: 'convai', ready: true}), true);
});
