import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve as absolutePath} from 'node:path';
import {runInNewContext} from 'node:vm';
import {silentWav} from './speech-audio.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {variantSeed} from './voice-variants.mjs';
import {SpeechStream,splitSpeechText} from './speech-stream.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';
import {BufferedPcm, waitUntil} from './group-lookahead.mjs';
import {NaturalSpeech, OMNI_TAGS, speechPhrases} from './natural-speech.mjs';
import {textExpressionSignal} from './text-emotion.mjs';
import {analyseReply, planSignal, createPlanner, phraseOffsets, baselineFromSignal} from './emotion-analysis.mjs';
import {EmotionSelection, waitLateEmotion} from './emotion-selector.mjs';
import {MultilingualConversations, planTurnVoice, replyVoice} from './multilingual.mjs';

// Execute the production routing/publication functions. These checks catch a
// future shared batching path accidentally processing remote Convai speech.
const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
// The per-turn voice plan (Multilingual conversations) is part of the routing under test.
const code = section('const turnVoices = new Map();', 'const warmUsesConvaiVoice')
  + section('async function synthesizeReply(', 'async function status(')
  + section('function continuousSpeech(', 'async function respond(')
  + section('async function respond(', 'const micPath =');
function fixture({local = false, available = true, audioFailure = false, continuous = false, voiceSelection, jaliFace = null,
  multilingual = new MultilingualConversations()} = {}) {
  const calls = [], publications = [];
  const remote = {text: 'A complete reply. With two sentences.', sessionID: 'test-session',
    audio: silentWav().toString('base64'), faces: [{at: 0, values: [0.2]}],
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds', timing: {audioRoute: 'convai-data-only'}};
  const selectedVoice = voiceSelection ?? {provider:'pocket',usesProfile: () => local};
  const sandbox = {remote, calls, publications, runtime: 'test-runtime', replyPath: 'reply.json',
    localVoice: selectedVoice, multilingual, planTurnVoice, replyVoice, variantSeed,
    ownedPocketFace:()=>{},lipsync:{analyse:async()=>{calls.push('rhubarb');return{mouthCues:[],mouthCuesFormat:'rhubarb-phonetic-v1'};}},
    jaliFace,textExpressionSignal,analyseReply,planSignal,createPlanner,phraseOffsets,baselineFromSignal,
    emotionSelection:new EmotionSelection(),waitLateEmotion,
    splitSpeechText,naturalSpeech:new NaturalSpeech(),OMNI_TAGS,speechPhrases,logNaturalSpeech:()=>{},streaming:0,writeStreamManifest:async value=>calls.push(['omni-manifest',value]),
    deliverPocketSpeech: async ({result,profile,speech}) => {
      calls.push(['pocket-stream',profile.key,result.text]);
      return {...result,continuous:true,timing:{...result.timing,voiceProvider:'pocket'},
        liveDelivery:{published:speech.published,ended:speech.ended,generated:speech.generated,id:speech.token}};
    },
    throwIfCancelled: () => {}, audioReady: async () => available,
    readSpeechState: async () => ({continuousAvailable: continuous}),
    readFile: async () => '{}', preparedInputs: new WeakMap(),
    ConvaiContinuousSpeech: class {
      constructor(options) { this.callbacks = options; this.published = true; this.ended = true; this.generated = true; this.token = 'continuous-owner';
        this.options = {token: this.token, onFrame: () => calls.push('live-frame')}; }
      async fail() { calls.push('live-failed'); }
      wakeUp() {}
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
    lookahead: {busy: false, setSource: value => calls.push(['lookahead-source', value.text, value.userText]), cancel() {}},
    slots: {begin: async () => calls.push('begin-slot'), write: async (id, index, bytes) => {
      calls.push(['write-slot', index, bytes]); if (audioFailure) throw Error('Fake disk error');
      return {event: 'convai_reply_0', duration: 0.1};
    }},
    SpeechStream,
    randomUUID: () => 'slot-owner', buildFacialTimeline: result => {
      if(result.timing?.voiceProvider==='omni')return{source:'local-phonetic'};
      assert.equal(result.faces,remote.faces);return{source:'convai-arkit61'};},
    atomic: async (path, value) => { publications.push([path, JSON.parse(value)]); return true; },
    resolve: (...parts) => parts.join('/'), sessionKey: () => 'exact-session',
    realtimeSessions: new Map(), sessions: new Map(), connections: {used: () => calls.push('used')},
    measure: async () => {}, status: async () => {}, Date, AbortController, console: {error() {}},
    knowledgeRouter: {activity: async (prepared, event, detail) => calls.push(['knowledge', prepared, event, detail])},
    stagedKnowledgeTurn: prepared => calls.push(['staged', prepared]),
  };
  runInNewContext(code + ';globalThis.api={respond,publishResult,continuousSpeech,synthesizeReply};', sandbox);
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

test('local microphone speech keeps the original submitted receipt when the text/context projection refreshes',async()=>{
  const f=fixture({local:true,continuous:true});
  const original={input:{...f.input},guard:'original'},refreshed={input:f.input,guard:'refreshed'};
  f.preparedInputs.set(f.input,refreshed);
  let ownedSpeech;
  const sandbox={...f,deliverPocketSpeech:async value=>{ownedSpeech=value.speech;return value.result;}};
  runInNewContext(code+';globalThis.runLocal=synthesizeReply;',sandbox);
  await sandbox.runLocal(f.input,{...f.remote,audio:undefined},undefined,async()=>true,f.profile,original);
  await ownedSpeech.callbacks.onGenerated('Local reply heard by V');
  assert.equal(f.calls.find(value=>value[0]==='knowledge')[1],original);
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

test('local voice requires continuous game admission instead of collecting a complete WAV or splitting text', async () => {
  const f = fixture({local: true});
  const result = await f.api.respond(f.input, f.profile,{current:async()=>true});
  assert.equal(f.calls[0][1].ttsEnabled, false);
  assert.equal(f.calls.filter(x=>Array.isArray(x)&&x[0]==='pocket-stream').length,0);
  assert.equal(result.audio,undefined);assert.equal(result.streamPlan,undefined);
  assert.match(result.audioError,/streaming is unavailable/);
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

test('Pocket submits the whole reply once to its independent PCM producer when the continuous controller is available', async () => {
  const f = fixture({local: true, continuous: true});
  const result = await f.api.respond(f.input, f.profile,{current:async()=>true});
  assert.equal(f.calls[0][1].ttsEnabled, false);
  assert.deepEqual(f.calls.filter(value=>Array.isArray(value)&&value[0]==='pocket-stream'),
    [['pocket-stream',f.profile.key,f.remote.text]]);
  assert.ok(!f.calls.includes('live-frame'));assert.ok(!f.calls.includes('split'));
  assert.equal(result.continuous,true);assert.equal(result.streamPlan,undefined);
});

test('continuous provider completion without game playback drain cannot be called delivered', async () => {
  const f = fixture({continuous: true}), current = async () => true;
  const result = await f.api.respond(f.input, f.profile, {current});
  await assert.rejects(f.api.publishResult(f.input, f.profile,
    {...result, liveDelivery: {...result.liveDelivery, ended: false}}, current), /did not finish/);
  assert.equal(f.publications.length, 0); assert.equal(f.realtimeSessions.size, 0);
});

test('failure after cached local admission cannot re-submit the same dialogue prompt',async()=>{
  const f=fixture({local:true,continuous:true});
  f.deliverPocketSpeech=async()=>{throw Error('admitted stream stopped');};
  // Replace the injected global used by the actual production respond path.
  const localSandbox={...f};
  runInNewContext(code+';globalThis.runCached=respond;',localSandbox);
  await assert.rejects(localSandbox.runCached(f.input,f.profile,{prepared:Promise.resolve({...f.remote,audio:undefined}),
    current:async()=>true}),/admitted stream stopped/);
  assert.equal(f.calls.filter(value=>Array.isArray(value)&&value[0]==='send').length,0);
});

test('the validated wider registry selects Pocket only for the matching reference; unprepared cast stays continuous Convai', async () => {
  const voices = new VoiceSelection({version: 1, provider: 'pocket', engine: 'pocket-tts',
    runtime:Object.fromEntries(['sourceDirectory','exportDirectory','referenceDirectory','workDirectory'].map(key=>[key,absolutePath('fixture',key)])),
    model:{sha256:'a'.repeat(64),configSha256:'b'.repeat(64),tokenizerSha256:'c'.repeat(64),receiptSha256:'d'.repeat(64),
      inputIdentity:'e'.repeat(64),selectedStep:1500},voices: {
    alex: {reference: 'runtime/voice-references/alex.wav', sha256: 'a'.repeat(64), transcript: 'Hello.'},
    'blue-moon': {status: 'unprepared'},
  }}, {factory() { throw Error('routing checks must not run neural inference'); }});
  const local = fixture({voiceSelection: voices, continuous: true});
  local.input.profileKey = 'alex'; local.profile.key = 'alex';
  const reply = await local.api.respond(local.input, local.profile,{current:async()=>true});
  assert.equal(local.calls[0][1].ttsEnabled, false);
  assert.equal(reply.continuous,true);assert.equal(reply.streamPlan,undefined);assert.equal(local.calls.includes('live-frame'),false);

  const remote = fixture({voiceSelection: voices, continuous: true});
  remote.input.profileKey = 'blue-moon'; remote.profile.key = 'blue-moon';
  const response = await remote.api.respond(remote.input, remote.profile, {current: async () => true});
  assert.equal(remote.calls.find(value => Array.isArray(value) && value[0] === 'send')[1].ttsEnabled, true);
  assert.equal(response.continuous, true); assert.equal(remote.calls.includes('split'), false);
  assert.equal(response.streamPlan, undefined);
  assert.equal(remote.calls.filter(value => Array.isArray(value) && value[0] === 'send').length, 1);
});

// A group look-ahead turn is generated while the previous speaker is audible and
// held until the game submits it (bridge/group-lookahead.mjs).
function heldTurn() {
  let state = 'held', release, cancel;
  const claimed = new Promise((resolve, reject) => { release = resolve; cancel = reject; });
  claimed.catch(() => {});
  return {claimed, isHeld: () => state === 'held', markReady() { this.ready = true; }, waitClaimed: signal => abortable(claimed, signal),
    claim() { state = 'claimed'; release(); }, abort() { state = 'cancelled'; cancel(Object.assign(Error('cancelled'), {name: 'AbortError'})); }};
}
const packet = (index, at) => ({index, offsetFrames: at, frames: 4, pcm: Float32Array.from([1, 2, 3, 4])});

test('a held Pocket turn synthesizes the whole text once into memory, then plays it in order after the claim', async () => {
  const f = fixture({local: true, continuous: true}), ahead = heldTurn(), delivered = [], synthesized = [];
  const current = async () => true; current.ahead = ahead;
  const localVoice = {...f.localVoice, async synthesizeStream(profile, text, {onPcm}) {
    synthesized.push([profile, text]); await onPcm(packet(1, 0)); await onPcm(packet(2, 4)); return {frames: 8};
  }};
  const sandbox = {...f, localVoice, BufferedPcm, waitUntil, realtime: {...f.realtime, localPcmBusy: false},
    deliverPocketSpeech: async value => { delivered.push(value); return {...value.result, continuous: true}; }};
  runInNewContext(code + ';globalThis.run=synthesizeReply;', sandbox);
  const running = sandbox.run(f.input, {...f.remote, audio: undefined}, undefined, current, f.profile);
  await turn(); await turn();
  assert.deepEqual(synthesized, [[f.profile.key, f.remote.text]], 'the complete reply text is sent to Pocket exactly once');
  assert.equal(delivered.length, 0, 'nothing reaches the single renderer while the previous speaker is audible');
  ahead.claim(); await running;
  assert.equal(delivered.length, 1); assert.equal(delivered[0].prefetched.packets.length, 2);
  assert.equal(synthesized.length, 1, 'the claim does not synthesize again');
});

test('cancelling a held Pocket turn stops its synthesis and never reaches the renderer', async () => {
  const f = fixture({local: true, continuous: true}), ahead = heldTurn(), delivered = [], controller = new AbortController();
  let synthesisSignal; const current = async () => true; current.ahead = ahead;
  const localVoice = {...f.localVoice, synthesizeStream: (profile, text, {signal}) => new Promise((_, reject) => {
    synthesisSignal = signal; signal.addEventListener('abort', () => reject(Error('stopped')), {once: true});
  })};
  const sandbox = {...f, localVoice, BufferedPcm, waitUntil, realtime: {...f.realtime, localPcmBusy: false},
    throwIfCancelled: signal => { if (signal?.aborted) throw Object.assign(Error('cancelled'), {name: 'AbortError'}); },
    deliverPocketSpeech: async value => { delivered.push(value); return value.result; }};
  runInNewContext(code + ';globalThis.run=synthesizeReply;', sandbox);
  const running = sandbox.run(f.input, {...f.remote, audio: undefined}, controller.signal, current, f.profile);
  await turn(); await turn();
  const rejected = assert.rejects(running, {name: 'AbortError'});
  ahead.abort(); await rejected;
  assert.equal(synthesisSignal.aborted, true); assert.equal(delivered.length, 0);
});

test('a held Omni turn waits for the previous speaker to finish rendering phrases before queueing GPU work', async () => {
  const f = fixture({continuous: true}), ahead = heldTurn(), order = [];
  const current = async () => true; current.ahead = ahead;
  const localVoice = {provider: 'omni', steps: 16, usesProfile: () => true, synthesize: async (profile, text) => {
    order.push('gpu'); return {audio: 'AAAA', faces: [], captions: [], timing: {}};
  }};
  const sandbox = {...f, localVoice, waitUntil, BufferedPcm, streaming: 1, jaliFace: null};
  runInNewContext(code + ';globalThis.run=synthesizeReply;globalThis.finish=()=>{streaming=0;};', sandbox);
  const running = sandbox.run(f.input, {...f.remote, audio: undefined}, undefined, current, f.profile);
  await new Promise(done => setTimeout(done, 120));
  assert.deepEqual(order, [], 'queueing behind the previous speaker would delay its next phrase');
  sandbox.finish(); const result = await running;
  assert.ok(order.length >= 1); assert.equal(typeof result.audio, 'string');
  // An ordinary (not held) turn never waits.
  const normal = fixture({continuous: true}), plain = {...normal, localVoice, waitUntil, BufferedPcm, streaming: 1, jaliFace: null};
  runInNewContext(code + ';globalThis.run=synthesizeReply;', plain);
  await plain.run(normal.input, {...normal.remote, audio: undefined}, undefined, async () => true, normal.profile);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {resolve, promise}; };
function invitationVoiceFixture({reconfigure = async () => {}, retire = async () => {}, prepare} = {}) {
  const changes = [], relationshipChanges = [], calls = [], local = new Set(['alex']);
  const localVoice = {provider:'pocket',routeRevision: 0, consumeRouteChanges: () => changes.splice(0),
    usesProfile: profile => local.has(profile), profileReady: profile => local.has(profile),
    prepareProfile: async (profile, options) => {
      calls.push(['prepare', profile]);
      return prepare ? prepare(profile, options) : local.has(profile)
        ? {provider: 'pocket', ready: true, profile} : {provider: 'convai', ready: true, reason: 'selected'};
    }};
  const sandbox = {localVoice, abortable, throwIfCancelled, stopped: false, active: null, streaming: 0,
    polling: false, micPolling: false, mic: {current: null}, phone: {active: null}, prefetchPolling: false, memoryQuiescing: 0,
    lookahead: {busy: false, cancel() {}, claim: () => null},
    relationshipRoutes: {revision: 0, consumeRouteChanges: () => relationshipChanges.splice(0)}, prewarmObserved: 'prior',
    retireRelationshipConnections: async (connections, keys) => {
      assert.equal(connections, sandbox.connections); calls.push(['retire', [...keys]]); return retire(keys);
    },
    connections: {reconfigure: async keys => { calls.push(['reconfigure', [...keys]]); return reconfigure(keys); }}};
  runInNewContext(section('let voiceRouteSync =', 'const invitations =')
    + section('async function pollMicrophone(', 'async function tick(')
    + section('async function tick(', 'async function pollPrefetch(')
    + ';globalThis.api={syncVoiceRoutes,syncRelationshipRoutes,prepareInvitedVoice,voiceBoundaryBusy,invitedVoiceCurrent,tick,pollMicrophone,'
    + 'reserved:()=>voiceRouteReservation,relationshipReserved:()=>relationshipRouteReservation,'
    + 'queued:()=>voiceRoutePending.size,waiters:()=>voiceRouteWaiters.size};', sandbox);
  return {...sandbox, context: sandbox, local, changes, calls,
    mark(keys) { localVoice.routeRevision++; changes.push(...keys); },
    markRelationship(keys) { sandbox.relationshipRoutes.revision++; relationshipChanges.push(...keys); }};
}

test('voice preparation holds Invite readiness until the affected connection pages are reconciled', async () => {
  const held = deferred(), f = invitationVoiceFixture({reconfigure: () => held.promise});
  f.mark(['alex']); let ready = false;
  const preparation = f.api.prepareInvitedVoice('alex').then(receipt => { ready = true; return receipt; });
  await turn(); assert.equal(ready, false);
  assert.deepEqual(f.calls, [['prepare', 'alex'], ['reconfigure', ['alex']]]);
  held.resolve(); const receipt = await preparation;
  assert.equal(receipt.provider, 'pocket'); assert.equal(receipt.profile, 'alex'); assert.equal(receipt.ready, true);
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
  for (const receipt of [undefined, {provider: 'pocket', ready: false, profile: 'alex'},
    {provider: 'pocket', ready: true, profile: 'judy-alvarez'}, {provider: 'other', ready: true}]) {
    const f = invitationVoiceFixture({prepare: async () => receipt});
    await assert.rejects(f.api.prepareInvitedVoice('alex'), /readiness could not be verified/);
    assert.equal(f.calls.filter(call => call[0] === 'reconfigure').length, 0);
  }
  const f = invitationVoiceFixture(); f.context.stopped = true;
  await assert.rejects(f.api.prepareInvitedVoice('alex'), /closed/);
});

test('the routing boundary includes text, continuous audio, microphone, phone and input/context ownership', () => {
  const f = invitationVoiceFixture();
  assert.equal(f.api.voiceBoundaryBusy(), false);
  for (const key of ['active','streaming','polling','micPolling','prefetchPolling','memoryQuiescing']) {
    const previous = f.context[key]; f.context[key] = true;
    assert.equal(f.api.voiceBoundaryBusy(), true, key); f.context[key] = previous;
  }
  // A held group look-ahead owns a connection page even between turns.
  f.context.lookahead.busy = true; assert.equal(f.api.voiceBoundaryBusy(), true, 'lookahead');
  f.context.lookahead.busy = false;
  f.context.mic.current = {}; assert.equal(f.api.voiceBoundaryBusy(), true);
  f.context.mic.current = null; assert.equal(f.api.voiceBoundaryBusy(), false);
  f.context.phone.active = {}; assert.equal(f.api.voiceBoundaryBusy(), true);
  f.context.phone.active = null; assert.equal(f.api.voiceBoundaryBusy(), false);
});

test('Omni16 and32 use one original text reply then their separate native phrase/phonetic pipeline',async()=>{
  for(const steps of [16,32]){
    const generated=[],voice={provider:'omni',steps,usesProfile:()=>true,
      async synthesize(key,text,options){generated.push({key,text,steps:options.steps});
        return{audio:silentWav().toString('base64'),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
    const f=fixture({voiceSelection:voice,continuous:true}),current=async()=>true;
    f.remote.text='We have a long enough original sentence to produce the first local phrase. Then we have another long enough sentence for the following phrase.';
    const result=await f.api.respond(f.input,f.profile,{current});
    assert.equal(f.calls.find(value=>Array.isArray(value)&&value[0]==='send')[1].ttsEnabled,false);
    assert.equal(result.continuous,undefined);assert.equal(result.streamPlan.steps,steps);
    // Phrase 2 is queued beside phrase 1 so the GPU renders it during phrase 1's
    // lip analysis and publication; it is handed to the stream, never rendered twice.
    assert.equal(generated.length,2);assert.equal(generated[1].text,result.streamPlan.phrases[1]);
    assert.ok(generated.every(value=>value.steps===steps));
    assert.ok(!f.calls.some(value=>Array.isArray(value)&&value[0]==='pocket-stream'));
    // Publication uses actual SpeechStream; fixed steps survive every phrase.
    await f.api.publishResult(f.input,f.profile,result,current);
    assert.equal(generated.length,result.streamPlan.phrases.length);
    assert.ok(generated.every(value=>value.steps===steps));
    assert.equal(f.calls.filter(value=>Array.isArray(value)&&value[0]==='send').length,1);
    const reply=f.publications.find(([path])=>path==='reply.json')[1];
    assert.ok(reply.audio&&reply.stream);assert.equal(reply.continuous,undefined);
  }
});

test('with local facial weights Omni phrases use the game-trained model and Rhubarb stays the fallback',async()=>{
  const analysed=[],voice={provider:'omni',steps:32,usesProfile:()=>true,
    async synthesize(){return{audio:silentWav().toString('base64'),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
  const jaliFace={async analyseWav(audio){analysed.push(audio);return{jaliFrames:{model:true},timing:{lipEngine:'jali-audio-v1'}};}};
  const f=fixture({voiceSelection:voice,continuous:true,jaliFace});
  const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.equal(analysed.length,1);assert.deepEqual(result.jaliFrames,{model:true});
  assert.equal(result.timing.lipEngine,'jali-audio-v1');assert.ok(!f.calls.includes('rhubarb'));
  const failing=fixture({voiceSelection:voice,continuous:true,jaliFace:{async analyseWav(){throw Error('worker stopped');}}});
  const fallback=await failing.api.respond(failing.input,failing.profile,{current:async()=>true});
  assert.ok(failing.calls.includes('rhubarb'));assert.equal(fallback.jaliFrames,undefined);
});

test('local voices get the context selector: sad text is sad, a plain reply rests neutral, Convai voices keep provider metadata',async()=>{
  const voice={provider:'omni',steps:32,usesProfile:()=>true,
    async synthesize(){return{audio:silentWav().toString('base64'),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
  const f=fixture({voiceSelection:voice,continuous:true});
  f.remote.text='I miss him. Jackie was family, and now he is gone. Sorry.';
  const local=await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.deepEqual({...local.expressionSignal,scale:undefined},{version:1,correlated:true,sequence:0,emotion:'Sadness',scale:undefined,basis:'text'});
  // October 8: a plain reply no longer gets the character's resting smile. It has no reply-level cue at all and
  // the receipt says the plan was calm.
  const plain=fixture({voiceSelection:voice,continuous:true});plain.remote.text='Meet me at the Afterlife at nine.';
  plain.input.profileKey='judy-alvarez';plain.profile.key='judy-alvarez';
  assert.equal((await plain.api.respond(plain.input,plain.profile,{current:async()=>true})).expressionSignal,undefined);
  const receipt=plain.publications.find(([path])=>path.endsWith('expression-receipt.json'));
  const {plan,...rest}=receipt[1];
  assert.deepEqual({...rest,updated:undefined},{version:3,updated:undefined,requestId:'r1',profile:'judy-alvarez',provider:'omni',
    selector:'context',emotion:null,scale:null,basis:null,delivered:false,convai:null,convaiLate:null});
  // The receipt also lists the per-segment plan (offsets and weights, never dialogue text).
  assert.equal(plan.trait,'reserved');assert.equal(plan.segments.length,1);assert.deepEqual(plan.segments[0].weights,{});
  assert.equal(plan.summary.basis,'calm');
  assert.equal(JSON.stringify(receipt[1]).includes('Afterlife'),false);
  const remote=fixture();remote.remote.text='I miss him. Sorry.';
  assert.equal((await remote.api.respond(remote.input,remote.profile,{current:async()=>true})).expressionSignal,undefined);
});

test('a text-only turn uses Convai\'s late emotion when it arrives before the first Omni phrase is ready',async()=>{
  const voice={provider:'omni',steps:32,usesProfile:()=>true,
    async synthesize(){return{audio:silentWav().toString('base64'),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
  const f=fixture({voiceSelection:voice,continuous:true});
  f.remote.text='Some days are easier than others. Thanks for asking.';
  const reply=f.realtime.reply, reads=[];
  f.realtime.reply=async(config,options)=>({...await reply(config,options),lateEmotionToken:7});
  f.realtime.lateEmotion=async(config,token)=>{reads.push(token);return{signal:{version:1,correlated:true,sequence:0,emotion:'Sadness',scale:2,basis:'ordered'}};};
  f.input.text='How are you holding up since Evelyn died?';
  const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.deepEqual(reads,[7]);
  assert.equal(result.expressionSignal.emotion,'Sadness');assert.equal(result.expressionSignal.basis,'ordered');
  assert.ok(result.expressionPlan.evidence.includes('convai:sadness'));
  for(const segment of result.expressionPlan.segments)assert.equal(segment.weights.joy??0,0);
  const receipts=f.publications.filter(([path])=>path.endsWith('expression-receipt.json')).map(([,value])=>value);
  assert.equal(receipts.at(-1).convai,'Sadness');
  // No token (a Convai-voiced or prefetched turn), no read.
  const g=fixture({voiceSelection:voice,continuous:true});g.realtime.lateEmotion=async()=>{throw Error('must not be read');};
  await g.api.respond(g.input,g.profile,{current:async()=>true});
});

test('voice playback Off yields one identified text request and never starts either local renderer',async()=>{
  for(const backend of ['pocket','omni','convai']){
    const f=fixture({voiceSelection:{provider:backend,playbackEnabled:false,usesProfile:()=>backend!=='convai'},continuous:true});
    const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
    assert.equal(result.audio,undefined);assert.equal(result.continuous,undefined);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].ttsEnabled,false);
  }
});

test('an active phone reply holds Invite voice reconciliation until its conversation boundary is idle', async () => {
  const f = invitationVoiceFixture();
  f.context.phone.active = {id: 'phone-turn'}; f.mark(['alex']);
  let ready = false;
  const preparation = f.api.prepareInvitedVoice('alex').then(value => { ready = true; return value; });
  await turn();
  assert.equal(ready, false); assert.equal(f.api.waiters(), 1); assert.equal(f.api.queued(), 1);
  await f.api.syncVoiceRoutes();
  assert.equal(f.calls.filter(call => call[0] === 'reconfigure').length, 0);
  f.context.phone.active = null; await f.api.syncVoiceRoutes();
  assert.equal((await preparation).provider, 'pocket');
  assert.equal(f.calls.filter(call => call[0] === 'reconfigure').length, 1);
  assert.equal(f.api.waiters(), 0); assert.equal(f.api.queued(), 0); assert.equal(f.api.reserved(), false);
});

test('relationship page retirement holds text, microphone and voice reconfiguration until its reservation releases', async () => {
  const held = deferred(), f = invitationVoiceFixture({retire: () => held.promise});
  f.markRelationship(['alex']); const retirement = f.api.syncRelationshipRoutes();
  assert.equal(f.api.relationshipReserved(), true); assert.equal(f.api.voiceBoundaryBusy(), true);
  f.mark(['alex']); await f.api.syncVoiceRoutes();
  await f.api.tick(); await f.api.pollMicrophone();
  assert.equal(f.context.polling, false); assert.equal(f.context.micPolling, false);
  assert.deepEqual(f.calls, [['retire', ['alex']]]); assert.equal(f.api.queued(), 1);
  held.resolve(); await retirement;
  assert.equal(f.api.relationshipReserved(), false); assert.equal(f.context.prewarmObserved, '');
  await f.api.syncVoiceRoutes();
  assert.deepEqual(f.calls, [['retire', ['alex']], ['reconfigure', ['alex']]]);
  assert.equal(f.api.queued(), 0); assert.equal(f.api.reserved(), false);
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
  assert.equal((await preparation).provider, 'pocket'); assert.equal(f.api.queued(), 0);
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
  const f = invitationVoiceFixture(), receipt = {provider: 'pocket', ready: true, profile: 'alex'};
  assert.equal(f.api.invitedVoiceCurrent('alex', receipt), true);
  f.localVoice.pending = true; assert.equal(f.api.invitedVoiceCurrent('alex', receipt), false);
  f.localVoice.pending = false; f.localVoice.availabilityPending = true;
  assert.equal(f.api.invitedVoiceCurrent('alex', receipt), false); f.localVoice.availabilityPending = false;
  f.localVoice.profileReady = () => false; assert.equal(f.api.invitedVoiceCurrent('alex', receipt), false);
  f.local.delete('alex'); assert.equal(f.api.invitedVoiceCurrent('alex', {provider: 'convai', ready: true}), true);
});

test('Natural speech: OmniVoice voices the tags the model wrote while every shown or stored text stays clean',async()=>{
  const raw='We have a long enough original sentence to produce [sigh] the first local phrase. Then we have another long enough sentence [laughter] for the following phrase.';
  const clean=raw.replace(/ ?\[[a-z-]+\]/g,'');
  for(const enabled of [true,false]){
    const generated=[],voice={provider:'omni',steps:16,usesProfile:()=>true,
      async synthesize(key,text){generated.push(text);
        return{audio:silentWav().toString('base64'),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
    const f=fixture({voiceSelection:voice,continuous:true}),current=async()=>true;
    f.naturalSpeech.update({naturalSpeech:enabled});
    f.remote.text=clean;f.remote.speechText=raw;
    const result=await f.api.respond(f.input,f.profile,{current});
    await f.api.publishResult(f.input,f.profile,result,current);
    assert.equal(result.text,clean);
    const voiced=generated.join(' ');
    if(enabled){assert.match(generated[0],/\[sigh\]/);assert.match(voiced,/\[laughter\]/);}
    else assert.ok(!/\[/.test(voiced),'setting off: no tag is voiced');
    const reply=f.publications.find(([path])=>path==='reply.json')[1];
    assert.equal(reply.text,clean);assert.ok(!/\[/.test(reply.text));
    const manifests=f.calls.filter(value=>Array.isArray(value)&&value[0]==='omni-manifest');
    assert.ok(manifests.length>0);
    assert.ok(manifests.every(([,manifest])=>manifest.chunks.every(chunk=>!/\[/.test(chunk.text))),'no tag in a stream chunk');
  }
});

test('Natural speech: Pocket is handed only the clean text, whatever the reply carried',async()=>{
  const f=fixture({local:true,continuous:true});
  f.naturalSpeech.update({naturalSpeech:true});
  f.remote.text='A complete reply. With two sentences.';f.remote.speechText='A complete reply. [laughter] With two sentences.';
  const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
  const spoken=f.calls.find(value=>Array.isArray(value)&&value[0]==='pocket-stream');
  assert.equal(spoken[2],'A complete reply. With two sentences.');
  assert.equal(result.text,'A complete reply. With two sentences.');
});

const EMOTION_TEXT = 'We have a long enough original sentence to produce the first local phrase. Then we have another long enough sentence for the following phrase.';
const EMOTION_MARKS = [{at: 0, name: 'interest', strength: 'subtle'},
  {at: EMOTION_TEXT.indexOf('Then'), name: 'sadness', strength: 'strong'}];

test('Expressive emotions: OmniVoice plans each phrase from the character\'s own marks, and the text reading is the fallback',async()=>{
  const voice={provider:'omni',steps:16,usesProfile:()=>true,
    async synthesize(){return{audio:silentWav().toString('base64'),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
  const f=fixture({voiceSelection:voice,continuous:true});
  f.remote.text=EMOTION_TEXT;f.remote.emotionMarks=EMOTION_MARKS;
  const marked=await f.api.respond(f.input,f.profile,{current:async()=>true});
  const plan=marked.expressionPlan,second=EMOTION_TEXT.indexOf('Then');
  assert.ok(plan.segments.every(segment=>segment.tags.includes('llm-emotion')));
  assert.equal(plan.segments.find(segment=>segment.start===0).dominant,'anticipation');
  assert.equal(plan.segments.find(segment=>segment.start===second).dominant,'sadness');
  assert.equal(marked.streamPlan.expressionPlan,plan,'the stream hands each phrase its own slice of this plan');
  assert.equal(marked.streamPlan.spans[1][0],second,'the second phrase opens at the sad mark');
  assert.ok(planSignal(plan).emotion,'the reply-level cue comes from the marks');
  // No marks in the reply: the text-based plan, exactly as before.
  const plainFixture=fixture({voiceSelection:voice,continuous:true});
  plainFixture.remote.text=EMOTION_TEXT;
  const plain=await plainFixture.api.respond(plainFixture.input,plainFixture.profile,{current:async()=>true});
  assert.ok(plain.expressionPlan.segments.every(segment=>!segment.tags.includes('llm-emotion')));
});

test('Expressive emotions: Pocket\'s streaming planner is given the marks, and a reply without marks keeps the text reading',async()=>{
  for(const marks of [EMOTION_MARKS,undefined]){
    const f=fixture({local:true,continuous:true});let captured;
    const sandbox={...f,deliverPocketSpeech:async value=>{captured=value;return value.result;}};
    runInNewContext(code+';globalThis.runLocal=synthesizeReply;',sandbox);
    await sandbox.runLocal(f.input,{...f.remote,text:EMOTION_TEXT,audio:undefined,...(marks?{emotionMarks:marks}:{})},undefined,async()=>true,f.profile);
    const planned=captured.speech.callbacks.planExpression(EMOTION_TEXT);
    assert.equal(captured.result.text,EMOTION_TEXT);
    if(marks){
      assert.equal(planned.segments.find(segment=>segment.start===EMOTION_TEXT.indexOf('Then')).dominant,'sadness');
      assert.ok(planned.segments.every(segment=>segment.tags.includes('llm-emotion')));
      assert.ok(captured.result.expressionPlan.segments.every(segment=>segment.tags.includes('llm-emotion')));
    }else assert.ok(planned.segments.every(segment=>!segment.tags.includes('llm-emotion')));
  }
});

// ---- Multilingual conversations: the voice of each turn, end to end through respond/synthesizeReply/publish ----
// Settings keep the voice on OmniVoice or the cloud voice while the setting is on; Pocket appears here only as the
// safety net (a fallback or hand-edited setup).
const SPANISH_REPLY='Claro que sí, V. Vamos al bar de Lizzie esta noche y hablamos con calma de todo lo que pasó.';
function multilingualVoice({provider='pocket'}={}){
  const generated=[];
  return {generated,provider,steps:provider==='omni'?16:undefined,usesProfile:()=>true,
    async synthesize(key,text,options){generated.push({key,text,language:options.language,steps:options.steps});
      return{audio:silentWav().toString('base64'),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
}
const multilingualOn=()=>{const value=new MultilingualConversations();value.update({multilingualConversations:true});return value;};
// The fixture's realtimeConfig mirrors the bridge: Convai TTS only when the turn does not use a local voice.
function multilingualFixture(options){
  const f=fixture(options);
  f.realtimeConfig=input=>({profileKey:input.profileKey,text:input.text,ttsEnabled:!f.turnUsesLocal(input)});
  runInNewContext(code+';globalThis.api={respond,publishResult};globalThis.turnUsesLocal=turnUsesLocal;',f);
  return f;
}
const sent=f=>f.calls.find(value=>Array.isArray(value)&&value[0]==='send')[1];
const pocketUsed=f=>f.calls.some(value=>Array.isArray(value)&&value[0]==='pocket-stream');

test('Multilingual off: a Spanish message keeps exactly the chosen local voice (no plan change)',async()=>{
  const voice=multilingualVoice();
  const f=multilingualFixture({voiceSelection:voice,continuous:true});
  f.input.text='¿Qué tal, Judy? ¿Vamos al bar esta noche?';
  await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.equal(sent(f).ttsEnabled,false);
  assert.equal(voice.generated.length,0,'Omni was not used');assert.ok(pocketUsed(f));
});

test('Multilingual with OmniVoice: Spanish and Japanese turns stay local and every phrase gets its language',async()=>{
  for(const [text,reply,language] of [['¿Qué tal, Judy? ¿Vamos al bar esta noche?',SPANISH_REPLY,'es'],
    ['こんにちは、ジュディ。今夜は何をしているの？','こんばんは、V。今夜はリジーズで少し飲んでから、ゆっくり話そうよ。','ja']]){
    const voice=multilingualVoice({provider:'omni'});
    const f=multilingualFixture({voiceSelection:voice,continuous:true,multilingual:multilingualOn()});
    f.input.text=text;f.remote.text=reply;
    const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
    assert.equal(sent(f).ttsEnabled,false);assert.ok(!pocketUsed(f));
    await f.api.publishResult(f.input,f.profile,result,async()=>true);
    assert.ok(voice.generated.length>=1&&voice.generated.every(value=>value.language===language&&value.steps===16),language);
    if(result.streamPlan)assert.equal(voice.generated.length,result.streamPlan.phrases.length);
    assert.equal(f.multilingual.lastLanguage,language,'the exchange language predicts the next turn without text');
  }
});

test('Multilingual with OmniVoice: an English reply to a Spanish message stays on Omni, without a language',async()=>{
  const voice=multilingualVoice({provider:'omni'});
  const f=multilingualFixture({voiceSelection:voice,continuous:true,multilingual:multilingualOn()});
  f.input.text='¿Qué tal, Judy? ¿Vamos al bar esta noche?';
  f.remote.text='Sure thing, V. Let us grab a drink at the Afterlife and talk it over.';
  await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.ok(voice.generated.length>=1&&voice.generated.every(value=>value.language===undefined));
});

test('Multilingual safety net: a Spanish turn on a Pocket fallback goes to the Convai cloud voice and plays Convai audio',async()=>{
  const voice=multilingualVoice();
  const f=multilingualFixture({voiceSelection:voice,continuous:false,multilingual:multilingualOn()});
  f.input.text='¿Qué tal, Judy? ¿Vamos al bar esta noche?';
  f.remote.text=SPANISH_REPLY;
  const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.equal(sent(f).ttsEnabled,true);
  assert.equal(result.audio,f.remote.audio);assert.equal(result.timing.audioRoute,'convai-data-only');
  assert.equal(voice.generated.length,0);assert.ok(!pocketUsed(f));
});

test('Multilingual safety net: an English message answered in Spanish on Pocket is shown, never read by Pocket',async()=>{
  const voice=multilingualVoice();
  const f=multilingualFixture({voiceSelection:voice,continuous:true,multilingual:multilingualOn()});
  f.input.text='How are you doing tonight, Judy?';
  f.remote.text=SPANISH_REPLY;
  const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.equal(sent(f).ttsEnabled,false);
  assert.equal(result.audio,undefined);assert.match(result.audioError,/English only/);
  assert.ok(!pocketUsed(f));
  await f.api.publishResult(f.input,f.profile,result,async()=>true);
  assert.equal(f.publications.find(([path])=>path==='reply.json')[1].text,SPANISH_REPLY);
});

// Several voices per ambient profile (bridge/voice-variants.mjs): the voice is picked once per turn from the NPC's
// identity; routing keeps asking about the base profile, and a voice without variants behaves exactly as before.
const ambientTurn = (extra = {}) => ({requestId: 'amb-1', generation: 1, entity: '4242ULL', profileKey: 'npc-fixer-male',
  name: 'Fixer', bodyType: 'male', text: 'Hello', ...extra});
const variantVoice = (picks = []) => {
  const asked = [];
  return {provider: 'pocket', steps: 16, asked, usesProfile: profile => profile === 'npc-fixer-male',
    voiceKeyFor(profile, seed) { asked.push([profile, seed]); return picks.length ? picks.shift() : profile; }};
};

test('a Pocket turn is spoken by the picked variant while routing keeps the base profile', async () => {
  const voice = variantVoice(['npc-fixer-male-v3']), delivered = [];
  const f = fixture({voiceSelection: voice, continuous: true});
  f.input = ambientTurn({archetype: {memoryKey: 'wat_kab_ripperdoc_01'}}); f.profile = {key: 'npc-fixer-male', name: 'Fixer'};
  const sandbox = {...f, deliverPocketSpeech: async value => { delivered.push(value); return {...value.result, continuous: true}; }};
  runInNewContext(code + ';globalThis.run=synthesizeReply;', sandbox);
  await sandbox.run(f.input, {...f.remote, audio: undefined}, undefined, async () => true, f.profile);
  assert.equal(delivered[0].voiceKey, 'npc-fixer-male-v3'); assert.equal(delivered[0].profile.key, 'npc-fixer-male');
  assert.deepEqual(voice.asked, [['npc-fixer-male', 'wat_kab_ripperdoc_01']], 'a vendor is identified by its shop record');
});

test('a held Pocket turn prefetches with the same variant its delivery uses, decided once for the turn', async () => {
  const voice = variantVoice(['npc-fixer-male-v2', 'npc-fixer-male-v4']);
  const f = fixture({voiceSelection: voice, continuous: true}), ahead = heldTurn(), delivered = [], synthesized = [];
  f.input = ambientTurn(); f.profile = {key: 'npc-fixer-male', name: 'Fixer'};
  const current = async () => true; current.ahead = ahead;
  const localVoice = {...voice, async synthesizeStream(key, text, {onPcm}) { synthesized.push(key); await onPcm(packet(1, 0)); return {frames: 4}; }};
  const sandbox = {...f, localVoice, BufferedPcm, waitUntil, realtime: {...f.realtime, localPcmBusy: false},
    deliverPocketSpeech: async value => { delivered.push(value); return {...value.result, continuous: true}; }};
  runInNewContext(code + ';globalThis.run=synthesizeReply;', sandbox);
  const running = sandbox.run(f.input, {...f.remote, audio: undefined}, undefined, current, f.profile);
  await turn(); await turn(); ahead.claim(); await running;
  assert.deepEqual(synthesized, ['npc-fixer-male-v2']);
  assert.equal(delivered[0].voiceKey, 'npc-fixer-male-v2');
  assert.equal(voice.asked.length, 1, 'one pick per turn');
});

test('every Omni phrase of a turn, including the stream the publication renders, uses the one picked variant', async () => {
  const generated = [], voice = variantVoice(['npc-fixer-male-v2', 'npc-fixer-male-v4', 'npc-fixer-male-v3']);
  voice.synthesize = async (key, text, options) => { generated.push(key);
    return {audio: silentWav().toString('base64'), faces: [], captions: [], timing: {voiceProvider: 'omnivoice'}}; };
  voice.provider = 'omni';
  const f = fixture({voiceSelection: voice, continuous: true}), current = async () => true;
  f.input = ambientTurn(); f.profile = {key: 'npc-fixer-male', name: 'Fixer'};
  f.remote.text = 'We have a long enough original sentence to produce the first local phrase. Then we have another long enough sentence for the following phrase.';
  const result = await f.api.respond(f.input, f.profile, {current});
  assert.equal(result.streamPlan.voiceKey, 'npc-fixer-male-v2');
  await f.api.publishResult(f.input, f.profile, result, current);
  assert.ok(generated.length >= 2); assert.ok(generated.every(key => key === 'npc-fixer-male-v2'), generated.join());
  assert.equal(voice.asked.length, 1);
  assert.equal(f.publications.find(([path]) => path === 'reply.json')[1].profile, 'npc-fixer-male', 'the reply still names the profile');
});

test('a voice without variants keeps the profile key for every call', async () => {
  const generated = [], voice = {provider: 'omni', steps: 16, usesProfile: () => true, voiceKeyFor: profile => profile,
    async synthesize(key) { generated.push(key); return {audio: silentWav().toString('base64'), faces: [], captions: [], timing: {}}; }};
  const f = fixture({voiceSelection: voice, continuous: true});
  f.input = ambientTurn(); f.profile = {key: 'npc-fixer-male', name: 'Fixer'};
  await f.api.respond(f.input, f.profile, {current: async () => true});
  assert.ok(generated.length && generated.every(key => key === 'npc-fixer-male'));
});
