import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve as absolutePath} from 'node:path';
import {runInNewContext} from 'node:vm';
import {silentWav} from './speech-audio.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {SpeechStream,splitSpeechText} from './speech-stream.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';

// Execute the production routing/publication functions. These checks catch a
// future shared batching path accidentally processing remote Convai speech.
const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const code = section('async function synthesizeReply(', 'async function status(')
  + section('function continuousSpeech(', 'async function respond(')
  + section('async function respond(', 'const micPath =');
function fixture({local = false, available = true, audioFailure = false, continuous = false, voiceSelection} = {}) {
  const calls = [], publications = [];
  const remote = {text: 'A complete reply. With two sentences.', sessionID: 'test-session',
    audio: silentWav().toString('base64'), faces: [{at: 0, values: [0.2]}],
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds', timing: {audioRoute: 'convai-data-only'}};
  const selectedVoice = voiceSelection ?? {provider:'pocket',usesProfile: () => local};
  const sandbox = {remote, calls, publications, runtime: 'test-runtime', replyPath: 'reply.json',
    localVoice: selectedVoice,
    ownedPocketFace:()=>{},lipsync:{analyse:async()=>({mouthCues:[],mouthCuesFormat:'rhubarb-phonetic-v1'})},
    jaliFace:null,
    splitSpeechText,streaming:0,writeStreamManifest:async value=>calls.push(['omni-manifest',value]),
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
