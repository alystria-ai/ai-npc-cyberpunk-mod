import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve as absolutePath} from 'node:path';
import {runInNewContext} from 'node:vm';
import {silentWav} from './speech-audio.mjs';
import {encodePcmWav} from './convai-audio-stream.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {variantSeed} from './voice-variants.mjs';
import {splitSpeechText} from './speech-phrases.mjs';
import {createOmniPcmVoice} from './omni-pcm.mjs';
import {abortable, throwIfCancelled} from './transport-pool.mjs';
import {BufferedPcm, waitUntil} from './group-lookahead.mjs';
import {NaturalSpeech, OMNI_TAGS, omniTagsFor, speechPhrases} from './natural-speech.mjs';
import {textExpressionSignal} from './text-emotion.mjs';
import {analyseReply, planSignal, createPlanner, baselineFromSignal} from './emotion-analysis.mjs';
import {EmotionSelection, waitLateEmotion} from './emotion-selector.mjs';
import {personKey} from './protocol.mjs';
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
function fixture({local = false, available = true, continuous = false, voiceSelection, jaliFace = null,
  multilingual = new MultilingualConversations()} = {}) {
  const calls = [], publications = [], delivered = [];
  const remote = {text: 'A complete reply. With two sentences.', sessionID: 'test-session',
    audio: silentWav().toString('base64'), faces: [{at: 0, values: [0.2]}],
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds', timing: {audioRoute: 'convai-data-only'}};
  // Not local: the player chose the Convai voice (`convaiVoiceAllowed`). A local voice that cannot run is a different fixture (voiceSelection with provider 'text').
  const selectedVoice = voiceSelection ?? {provider: local ? 'pocket' : 'convai', usesProfile: () => local, convaiVoiceAllowed: !local};
  // The turn's latency marks (bridge/turn-clock.mjs) are not under test here.
  const sandbox = {customCharacters: {has: key => String(key).startsWith('custom-')}, addonHost: {usesVoiceContext: () => false}, markStage: () => {}, markPublished: () => {}, turnMark: () => {}, mistral: {active: false}, replyStreaming: false, voiceLanguageNotice: {note: () => calls.push('voice-language-note')}, remote, calls, publications, runtime: 'test-runtime', replyPath: 'reply.json', keyNotice: () => ({}), dfNote: () => ({}),
    // The multilingual packs and Developer mode's last-reply capture (docs/VOICE_LANGUAGE_PACKS.md): none installed, capture off.
    languagePacks: {installed: false}, pocketLanguages: {speaks: () => false, packMissing: () => false, has: () => false, model: () => null, entry: () => null}, pocketLanguageNotice: {note() {}}, replyCapture: {enabled: false}, beginOmniCapture: () => {}, referenceOf: () => null, cloudReferenceOf: () => null,
    localVoice: selectedVoice, multilingual, speechLanguage: {evidence: null}, planTurnVoice, replyVoice, variantSeed, paceOf: () => null, omniPace: null,
    ownedPocketFace:()=>{},
    jaliFace,textExpressionSignal,analyseReply,planSignal,createPlanner,baselineFromSignal,
    emotionSelection:new EmotionSelection(),waitLateEmotion,personKey,
    splitSpeechText,naturalSpeech:new NaturalSpeech(),OMNI_TAGS,omniTagsFor,speechPhrases,logNaturalSpeech:()=>{},logFollowUp:()=>{},streaming:0,waitUntil,BufferedPcm,delivered,
    // The delivery function is the one both local voices share. OmniVoice's voice is driven the way deliverPocketSpeech drives it (the whole
    // reply text, or the held look-ahead's buffer), so the phrases reach the fake worker; Pocket's fake worker is not called here.
    deliverPocketSpeech: async value => {
      const {result, profile, speech, voice, voiceKey = profile.key, prefetched, language} = value;
      calls.push([selectedVoice.provider === 'omni' ? 'omni-stream' : 'pocket-stream', profile.key, result.text]); delivered.push(value);
      let response;
      if (selectedVoice.provider === 'omni') {
        if (prefetched) response = await prefetched.drain(() => {}, {});
        else {
          calls.push(['voice-stream', voiceKey, result.text]);
          response = await voice.synthesizeStream(voiceKey, result.text, {onPcm() {}, role: 'head', ...(language ? {language} : {}), utterance: {decide() {}, settle() {}}});
        }
      }
      return {...result,continuous:true,timing:{...result.timing,voiceProvider:response?.timing?.voiceProvider ?? 'pocket'},
        liveDelivery:{published:speech.published,ended:speech.ended,generated:speech.generated,id:speech.token}};
    },
    throwIfCancelled: () => {}, audioReady: async () => available,
    readSpeechState: async () => ({continuousAvailable: continuous}),
    // The turn path reads the cached copy (bridge/speech-state-cache.mjs); `available` stands for a live heartbeat here.
    readSpeechStateCached: async () => ({available, updated: Date.now(), continuousAvailable: continuous}),
    audioAvailable: state => state.available === true, leaseWake: {next: () => undefined},
    readFile: async () => '{}', preparedInputs: new WeakMap(),
    ConvaiContinuousSpeech: class {
      constructor(options) { this.callbacks = options; this.published = true; this.ended = true; this.generated = true; this.token = 'continuous-owner';
        this.options = {token: this.token, onFrame: () => calls.push('live-frame')}; }
      async fail() { calls.push('live-failed'); }
      wakeUp() {}
    },
    // Convai sends audio only when the Convai voice is the one speaking: a local voice speaks, or (a local voice that cannot run) nothing does.
    realtimeConfig: input => ({profileKey: input.profileKey, text: input.text, ttsEnabled: !selectedVoice.usesProfile(input.profileKey) && selectedVoice.convaiVoiceAllowed === true}),
    realtime: {localPcmBusy: false, reply: async (config, options) => {
      calls.push(['send', config]);
      if (options?.liveSpeech) {
        await options.liveSpeech.onFrame();
        return {...remote, audio: undefined, continuous: true};
      }
      return config.ttsEnabled ? remote : {...remote, audio: undefined};
    }},
    prefetch: {invalidate() {}, published: () => calls.push('prefetch-published')}, jaliFace,
    lookahead: {busy: false, setSource: value => calls.push(['lookahead-source', value.text, value.userText]), cancel() {}},
    createOmniPcmVoice,
    atomic: async (path, value) => { publications.push([path, JSON.parse(value)]); return true; },
    resolve: (...parts) => parts.join('/'), sessionKey: () => 'exact-session',
    realtimeSessions: new Map(), sessions: new Map(), connections: {used: () => calls.push('used')},
    measure: async () => {}, status: async () => {}, Date, AbortController, console: {error() {}},
    knowledgeRouter: {activity: async (prepared, event, detail) => calls.push(['knowledge', prepared, event, detail])},
    stagedKnowledgeTurn: prepared => calls.push(['staged', prepared]),
    publishCallOff: () => {}, publishEddies: () => {},
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

test('an add-on speaker has no knowledge receipt: its generated text must not end the voice stream (Delamain lines were cut off)', async () => {
  const f = fixture(), addonInput = {...f.input, profileKey: 'addon-delamain-cab-delamain', addon: {id: 'delamain-cab', speaker: 'delamain', event: 'boarded'}};
  const speech = f.api.continuousSpeech(addonInput, {key: addonInput.profileKey, name: 'Delamain'}, async () => true);
  await speech.callbacks.onGenerated('Welcome aboard, V.');
  assert.ok(!f.calls.some(value => value[0] === 'knowledge' || value[0] === 'staged'), 'no knowledge receipt is reported for an add-on turn');
  // A turn that is no longer current still stops, exactly like any other.
  const stale = f.api.continuousSpeech(addonInput, {key: addonInput.profileKey, name: 'Delamain'}, async () => false);
  await assert.rejects(stale.callbacks.onGenerated('Late line'), /owner changed/);
});

test('a player-made character has no knowledge receipt either: its generated text must not end the voice stream (report e0fc2ad3)', async () => {
  const f = fixture({local: true, continuous: true}), customInput = {...f.input, profileKey: 'custom-kaori-sqss'};
  const profile = {key: customInput.profileKey, name: 'Kaori'};
  const speech = f.api.continuousSpeech(customInput, profile, async () => true);
  await speech.callbacks.onGenerated('Hello, V.');
  assert.ok(!f.calls.some(value => value[0] === 'knowledge' || value[0] === 'staged'), 'no knowledge receipt is reported for a custom character');
  // A turn that is no longer current still stops, like any other.
  const stale = f.api.continuousSpeech(customInput, profile, async () => false);
  await assert.rejects(stale.callbacks.onGenerated('Late line'), /owner changed/);
  // A named character without a receipt is still refused (a real bug stays loud).
  const named = f.api.continuousSpeech(f.input, f.profile, async () => true);
  await assert.rejects(named.callbacks.onGenerated('Reply'), /receipt owner changed/);
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

test('the Convai voice chosen on purpose, with no continuous playback in the game, is one written-reply turn: text asked once, no audio, no second request', async () => {
  const f = fixture(), current = async () => true;
  const result = await f.api.respond(f.input, f.profile, {current});
  const sends = f.calls.filter(x => Array.isArray(x) && x[0] === 'send');
  assert.equal(sends.length, 1); assert.equal(sends[0][1].ttsEnabled, false, 'no audio is requested: there is nothing that could play it');
  assert.ok(!f.calls.includes('split')); assert.equal(result.streamPlan, undefined);
  assert.equal(result.audio, undefined); assert.equal(result.timing.audioRoute, f.remote.timing.audioRoute, 'provider timing is kept');
  assert.match(result.audioError, /streaming is unavailable/);
  assert.equal(await f.api.publishResult(f.input, f.profile, result, current), true);
  const reply = f.publications.find(([path]) => path === 'reply.json')[1];
  assert.equal(reply.text, f.remote.text); assert.equal(reply.audio, undefined); assert.equal(reply.stream, undefined);
  assert.match(reply.audioError, /written reply/);
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'send').length, 1);
  assert.ok(!f.calls.some(x => Array.isArray(x) && String(x[0]).startsWith('write-slot')), 'nothing is written for Audioware');
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

test('the loaded Convai streaming controller speaks the Convai voice live: one send, one admission, and no second reply replaces it', async () => {
  const f = fixture({continuous: true}), current = async () => true;
  const result = await f.api.respond(f.input, f.profile, {current});
  assert.equal(result.continuous, true); assert.equal(result.liveDelivery.ended, true);
  assert.equal(f.calls.filter(x => x === 'live-frame').length, 1);
  assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'send').length, 1);
  assert.ok(!f.calls.includes('split')); assert.equal(result.streamPlan, undefined);
  assert.equal(await f.api.publishResult(f.input, f.profile, result, current), true);
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

test('the validated wider registry selects Pocket only for the matching reference; an unprepared character is written, never given to the Convai voice', async () => {
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
  assert.equal(remote.calls.find(value => Array.isArray(value) && value[0] === 'send')[1].ttsEnabled, false, 'Convai sends no audio for a character the chosen local voice does not speak');
  assert.equal(response.audio, undefined); assert.match(response.audioError, /unavailable right now/);
  assert.equal(response.timing.voiceProvider, 'none');
  assert.equal(response.continuous, undefined); assert.equal(remote.calls.includes('split'), false);
  assert.equal(response.streamPlan, undefined);
  assert.equal(remote.calls.filter(value => Array.isArray(value) && value[0] === 'send').length, 1);
});

test('a chosen local voice that cannot run: Convai sends no audio, no Convai live speech starts, and the written reply says why (owner rule 2026-10-21)', async () => {
  const dead = {provider: 'text', usesProfile: () => false, convaiVoiceAllowed: false};
  for (const continuous of [false, true]) {
    const f = fixture({voiceSelection: dead, continuous});
    const result = await f.api.respond(f.input, f.profile, {current: async () => true});
    const sends = f.calls.filter(value => Array.isArray(value) && value[0] === 'send');
    assert.equal(sends.length, 1); assert.equal(sends[0][1].ttsEnabled, false, 'Convai is asked for text only');
    assert.equal(f.calls.includes('live-frame'), false, 'no Convai live speech');
    assert.equal(result.audio, undefined); assert.equal(result.timing.voiceProvider, 'none');
    assert.match(result.audioError, /unavailable right now/);
    assert.equal(result.text, f.remote.text, 'the written reply is intact');
  }
  // The Convai voice chosen on purpose still speaks.
  const chosen = fixture({voiceSelection: {provider: 'convai', usesProfile: () => false, convaiVoiceAllowed: true}, continuous: true});
  const spoken = await chosen.api.respond(chosen.input, chosen.profile, {current: async () => true});
  assert.equal(chosen.calls.find(value => Array.isArray(value) && value[0] === 'send')[1].ttsEnabled, true);
  assert.equal(spoken.continuous, true); assert.equal(spoken.audio, undefined); assert.equal(chosen.calls.filter(value => value === 'live-frame').length, 1, 'the Convai voice is played live');
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

test('a held Omni turn waits for the previous speaker to finish rendering phrases before queueing GPU work, then renders into memory until it is claimed', async () => {
  const f = fixture({continuous: true}), ahead = heldTurn(), order = [], delivered = [];
  const current = async () => true; current.ahead = ahead;
  const localVoice = {provider: 'omni', steps: 16, usesProfile: () => true, synthesize: async (profile, text) => {
    order.push('gpu'); return {audio: encodePcmWav(new Float32Array(12000).fill(.1), 24000), timing: {}};
  }};
  const sandbox = {...f, localVoice, streaming: 1, jaliFace: null,
    deliverPocketSpeech: async value => { delivered.push(value); await value.prefetched.drain(() => {}, {}); return {...value.result, continuous: true}; }};
  runInNewContext(code + ';globalThis.run=synthesizeReply;globalThis.finish=()=>{streaming=0;};', sandbox);
  const running = sandbox.run(f.input, {...f.remote, audio: undefined}, undefined, current, f.profile);
  await new Promise(done => setTimeout(done, 120));
  assert.deepEqual(order, [], 'queueing behind the previous speaker would delay its next phrase');
  sandbox.finish(); await new Promise(done => setTimeout(done, 120));
  assert.ok(order.length >= 1, 'the look-ahead renders as soon as the previous speaker has finished its phrases');
  assert.equal(delivered.length, 0, 'nothing reaches the single renderer while the previous speaker is audible');
  ahead.claim(); const result = await running;
  assert.equal(delivered.length, 1); assert.equal(result.continuous, true);
  assert.equal(order.length, splitSpeechText(f.remote.text).length, 'each phrase was rendered once, not again after the claim');
  // An ordinary (not held) turn never waits.
  const normal = fixture({continuous: true, voiceSelection: localVoice}), plain = {...normal, localVoice, streaming: 1, jaliFace: null};
  const before = order.length;
  runInNewContext(code + ';globalThis.run=synthesizeReply;', plain);
  await plain.run(normal.input, {...normal.remote, audio: undefined}, undefined, async () => true, normal.profile);
  assert.ok(order.length > before, 'a turn that is not held starts rendering at once');
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
  // Add-ons are not under test here: no add-on speaker exists, so the add-on voice route never claims a key or a turn.
  const sandbox = {addonHost: {isSpeaker: () => false}, addonVoice: {voice: () => false},
    localVoice, abortable, throwIfCancelled, stopped: false, active: null, streaming: 0,
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

const wavOf = (seconds = .5) => encodePcmWav(new Float32Array(Math.round(24000 * seconds)).fill(.1), 24000);

test('Omni16 and32 use one original text reply, then the whole reply goes to the shared delivery and its phrases are rendered at that quality', async () => {
  for (const steps of [16, 32]) {
    const generated = [], voice = {provider: 'omni', steps, usesProfile: () => true,
      async synthesize(key, text, options) { generated.push({key, text, steps: options.steps}); return {audio: wavOf(), faces: [], captions: [], timing: {voiceProvider: 'omnivoice'}}; }};
    const f = fixture({voiceSelection: voice, continuous: true}), current = async () => true;
    f.remote.text = 'We have a long enough original sentence to produce the first local phrase. Then we have another long enough sentence for the following phrase.';
    const result = await f.api.respond(f.input, f.profile, {current});
    assert.equal(f.calls.find(value => Array.isArray(value) && value[0] === 'send')[1].ttsEnabled, false, 'Convai is asked for text only');
    assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'send').length, 1);
    assert.equal(result.continuous, true); assert.equal(result.streamPlan, undefined); assert.equal(result.audio, undefined);
    assert.equal(result.timing.voiceProvider, 'omni');
    // OmniVoice is delivered by the same function as Pocket, once, with the whole text; its phrases are what the worker renders.
    assert.deepEqual(f.calls.filter(value => Array.isArray(value) && value[0] === 'omni-stream'), [['omni-stream', f.profile.key, f.remote.text]]);
    assert.ok(!f.calls.some(value => Array.isArray(value) && value[0] === 'pocket-stream'));
    assert.deepEqual(generated.map(value => value.text), splitSpeechText(f.remote.text));
    assert.ok(generated.length >= 2 && generated.every(value => value.steps === steps && value.key === f.profile.key));
    // The live admission is the reply: nothing else is published for it.
    assert.equal(await f.api.publishResult(f.input, f.profile, result, current), true);
    assert.equal(f.publications.find(([path]) => path === 'reply.json'), undefined);
    assert.equal(generated.length, splitSpeechText(f.remote.text).length, 'publishing renders nothing again');
  }
});

test('OmniVoice with no continuous playback in the game is a written reply: nothing is rendered and the Convai voice is never asked', async () => {
  const generated = [], voice = {provider: 'omni', steps: 16, usesProfile: () => true,
    async synthesize(key, text) { generated.push(text); return {audio: wavOf(), faces: [], captions: [], timing: {}}; }};
  const f = fixture({voiceSelection: voice, continuous: false}), current = async () => true;
  const result = await f.api.respond(f.input, f.profile, {current});
  assert.equal(f.calls.find(value => Array.isArray(value) && value[0] === 'send')[1].ttsEnabled, false);
  assert.equal(result.audio, undefined); assert.match(result.audioError, /streaming is unavailable/);
  assert.equal(generated.length, 0); assert.equal(f.delivered.length, 0);
  assert.equal(result.continuous, undefined);
});

test('with local facial weights the game-trained model reaches OmniVoice\'s delivery as it does Pocket\'s; with none there is no analyser, and no separate lip analysis runs', async () => {
  const voice = {provider: 'omni', steps: 32, usesProfile: () => true,
    async synthesize() { return {audio: wavOf(), faces: [], captions: [], timing: {voiceProvider: 'omnivoice'}}; }};
  const jaliFace = {begin() { return {}; }};
  const f = fixture({voiceSelection: voice, continuous: true, jaliFace});
  const result = await f.api.respond(f.input, f.profile, {current: async () => true});
  assert.equal(f.delivered[0].jaliFace, jaliFace, 'the streaming face model is the one handed to the delivery');
  assert.equal(f.delivered[0].phoneAnalysis, undefined, 'no separate recogniser runs for OmniVoice');
  assert.equal(result.timing.voiceProvider, 'omni'); assert.equal(result.timing.lipEngine, undefined);
  assert.equal(result.jaliFrames, undefined); assert.equal(result.mouthCues, undefined);
  // The face comes from the same face builder as Pocket's: the audio the renderer plays, on its own clock (no per-phrase face file).
  assert.equal(typeof f.delivered[0].speech.callbacks.faceBuilder, 'function');
  const without = fixture({voiceSelection: voice, continuous: true});
  const bare = await without.api.respond(without.input, without.profile, {current: async () => true});
  assert.equal(without.delivered[0].jaliFace, null); assert.equal(bare.timing.voiceProvider, 'omni');
  assert.equal(bare.mouthCues, undefined); assert.equal(bare.jaliFrames, undefined);
});

test('local voices get the context selector: sad text is sad, a plain reply rests neutral, Convai voices keep provider metadata',async()=>{
  const voice={provider:'omni',steps:32,usesProfile:()=>true,
    async synthesize(){return{audio:wavOf(),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
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
    async synthesize(){return{audio:wavOf(),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
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
  // A chosen local voice that cannot run answers with the 'text' route (replies are written): a valid receipt while the character has no local voice.
  assert.equal(f.api.invitedVoiceCurrent('alex', {provider: 'text', ready: true, reason: 'unavailable'}), true);
  f.local.add('alex'); assert.equal(f.api.invitedVoiceCurrent('alex', {provider: 'text', ready: true}), false, 'stale once the local voice speaks the character again');
});

test('an Invite is ready with a written-reply receipt when the chosen local voice cannot run, and never needs the Convai voice', async () => {
  const f = invitationVoiceFixture({prepare: async () => ({provider: 'text', ready: true, reason: 'unavailable'})});
  f.local.delete('alex');
  const receipt = await f.api.prepareInvitedVoice('alex');
  assert.equal(receipt.provider, 'text'); assert.notEqual(receipt.provider, 'convai');
});

test('Natural speech: OmniVoice voices the tags the model wrote while every shown or stored text stays clean',async()=>{
  const raw='We have a long enough original sentence to produce [sigh] the first local phrase. Then we have another long enough sentence [laughter] for the following phrase.';
  const clean=raw.replace(/ ?\[[a-z-]+\]/g,'');
  for(const enabled of [true,false]){
    const generated=[],voice={provider:'omni',steps:16,usesProfile:()=>true,
      async synthesize(key,text){generated.push(text);
        return{audio:wavOf(),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
    const f=fixture({voiceSelection:voice,continuous:true}),current=async()=>true;
    f.naturalSpeech.update({naturalSpeech:enabled});
    f.remote.text=clean;f.remote.speechText=raw;
    const result=await f.api.respond(f.input,f.profile,{current});
    await f.api.publishResult(f.input,f.profile,result,current);
    assert.equal(result.text,clean);
    const voiced=generated.join(' ');
    if(enabled){assert.match(generated[0],/\[sigh\]/);assert.match(voiced,/\[laughter\]/);assert.equal(voiced.replace(/ ?\[[a-z-]+\]/g,''),clean);}
    else assert.deepEqual(generated,splitSpeechText(clean),'setting off: no tag is voiced');
    // The voice, the delivery (its subtitles and the face's text) and the published reply are given the clean text only: tags exist only in what the worker renders.
    assert.deepEqual(f.calls.filter(value=>Array.isArray(value)&&value[0]==='voice-stream').map(value=>value[2]),[clean]);
    assert.ok(f.calls.filter(value=>Array.isArray(value)&&value[0]==='omni-stream').every(value=>!/\[/.test(value[2])));
    assert.ok(f.delivered.every(value=>!/\[/.test(value.result.text)));
    assert.ok(!/\[/.test(result.text));
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
const EMOTION_MARKS = [{at: 0, name: 'joy', strength: 'subtle'},
  {at: EMOTION_TEXT.indexOf('Then'), name: 'sadness', strength: 'strong'}];

test('Expressive emotions: OmniVoice is planned from the character\'s own marks by the same continuous planner as Pocket, and the text reading is the fallback',async()=>{
  const voice={provider:'omni',steps:16,usesProfile:()=>true,
    async synthesize(){return{audio:wavOf(),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
  const f=fixture({voiceSelection:voice,continuous:true});
  f.remote.text=EMOTION_TEXT;f.remote.emotionMarks=EMOTION_MARKS;
  const marked=await f.api.respond(f.input,f.profile,{current:async()=>true});
  const plan=marked.expressionPlan,second=EMOTION_TEXT.indexOf('Then');
  assert.ok(plan.segments.every(segment=>segment.tags.includes('llm-emotion')));
  assert.equal(plan.segments.find(segment=>segment.start===0).dominant,'joy');
  assert.equal(plan.segments.find(segment=>segment.start===second).dominant,'sadness');
  assert.equal(marked.streamPlan,undefined,'no per-phrase plan: one plan for the whole reply');
  assert.ok(planSignal(plan).emotion,'the reply-level cue comes from the marks');
  // The planner the continuous speech re-runs as the audio arrives has the marks too.
  const planned=f.delivered[0].speech.callbacks.planExpression(EMOTION_TEXT);
  assert.equal(planned.segments.find(segment=>segment.start===second).dominant,'sadness');
  assert.ok(planned.segments.every(segment=>segment.tags.includes('llm-emotion')));
  // No marks in the reply: the text-based plan, exactly as before.
  const plainFixture=fixture({voiceSelection:voice,continuous:true});
  plainFixture.remote.text=EMOTION_TEXT;
  const plain=await plainFixture.api.respond(plainFixture.input,plainFixture.profile,{current:async()=>true});
  assert.ok(plain.expressionPlan.segments.every(segment=>!segment.tags.includes('llm-emotion')));
  assert.ok(plainFixture.delivered[0].speech.callbacks.planExpression(EMOTION_TEXT).segments.every(segment=>!segment.tags.includes('llm-emotion')));
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

// ---- Replies in the player's language: the voice of each turn, end to end through respond/synthesizeReply/publish ----
// There is no setting (2026-10-21): the language of the message plans the voice. OmniVoice speaks any language; Pocket (English only) shows a reply
// in another language as text and never hands it to the Convai cloud voice.
const SPANISH_REPLY='Claro que sí, V. Vamos al bar de Lizzie esta noche y hablamos con calma de todo lo que pasó.';
function multilingualVoice({provider='pocket'}={}){
  const generated=[],warmed=[];
  return {generated,warmed,provider,steps:provider==='omni'?16:undefined,usesProfile:()=>true,
    // The pack clip of the reply's language is prepared in the worker while the reply is written (VoiceSelection.warmOmniLanguage).
    async warmOmniLanguage(key,language){warmed.push({key,language});return true;},
    async synthesize(key,text,options){generated.push({key,text,language:options.language,steps:options.steps});
      return{audio:wavOf(),faces:[],captions:[],timing:{voiceProvider:'omnivoice'}};}};
}
const multilingualOn=()=>new MultilingualConversations();
// The fixture's realtimeConfig mirrors the bridge: Convai TTS only when the turn does not use a local voice.
function multilingualFixture(options){
  const f=fixture(options);
  f.realtimeConfig=input=>({profileKey:input.profileKey,text:input.text,ttsEnabled:!f.turnUsesLocal(input)});
  runInNewContext(code+';globalThis.api={respond,publishResult};globalThis.turnUsesLocal=turnUsesLocal;',f);
  return f;
}
const sent=f=>f.calls.find(value=>Array.isArray(value)&&value[0]==='send')[1];
const pocketUsed=f=>f.calls.some(value=>Array.isArray(value)&&value[0]==='pocket-stream');

test('a Spanish message answered in English keeps the chosen local voice (Pocket speaks the English reply)',async()=>{
  const voice=multilingualVoice();
  const f=multilingualFixture({voiceSelection:voice,continuous:true});
  f.input.text='¿Qué tal, Judy? ¿Vamos al bar esta noche?';
  await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.equal(sent(f).ttsEnabled,false);
  assert.equal(voice.generated.length,0,'Omni was not used');assert.ok(pocketUsed(f));
});

test('with OmniVoice: Spanish and Japanese turns stay local and every phrase gets its language',async()=>{
  for(const [text,reply,language] of [['¿Qué tal, Judy? ¿Vamos al bar esta noche?',SPANISH_REPLY,'es'],
    ['こんにちは、ジュディ。今夜は何をしているの？','こんばんは、V。今夜はリジーズで少し飲んでから、ゆっくり話そうよ。','ja']]){
    const voice=multilingualVoice({provider:'omni'});
    const f=multilingualFixture({voiceSelection:voice,continuous:true,multilingual:multilingualOn()});
    f.input.text=text;f.remote.text=reply;
    const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
    assert.equal(sent(f).ttsEnabled,false);assert.ok(!pocketUsed(f));
    await f.api.publishResult(f.input,f.profile,result,async()=>true);
    assert.ok(voice.generated.length>=1&&voice.generated.every(value=>value.language===language&&value.steps===16),language);
    assert.deepEqual(voice.generated.map(value=>value.text),splitSpeechText(reply),'every phrase of the reply, once');
    assert.equal(f.multilingual.lastLanguage,language,'the exchange language predicts the next turn without text');
    assert.deepEqual([...new Set(voice.warmed.map(value=>value.language))],[language],'the pack clip of the turn language was prepared ahead of the reply');
    assert.equal(voice.warmed.length,1,'once for the turn');
  }
});

test('with OmniVoice: an English reply to a Spanish message stays on Omni, without a language',async()=>{
  const voice=multilingualVoice({provider:'omni'});
  const f=multilingualFixture({voiceSelection:voice,continuous:true,multilingual:multilingualOn()});
  f.input.text='¿Qué tal, Judy? ¿Vamos al bar esta noche?';
  f.remote.text='Sure thing, V. Let us grab a drink at the Afterlife and talk it over.';
  await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.ok(voice.generated.length>=1&&voice.generated.every(value=>value.language===undefined));
});

test('with OmniVoice: an English turn prepares no pack clip',async()=>{
  const voice=multilingualVoice({provider:'omni'});
  const f=multilingualFixture({voiceSelection:voice,continuous:true,multilingual:multilingualOn()});
  f.input.text='Hey Judy, want to grab a drink tonight?';f.remote.text='Sure thing, V.';
  await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.equal(voice.warmed.length,0);
});

test('a Spanish turn answered in Spanish on Pocket is shown as text: no Convai cloud voice, no Pocket',async()=>{
  const voice=multilingualVoice();
  const f=multilingualFixture({voiceSelection:voice,continuous:false,multilingual:multilingualOn()});
  f.input.text='¿Qué tal, Judy? ¿Vamos al bar esta noche?';
  f.remote.text=SPANISH_REPLY;
  const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.equal(sent(f).ttsEnabled,false,'a local voice is chosen, so Convai is not asked for audio');
  assert.equal(result.audio,undefined);assert.match(result.audioError,/English only/);
  assert.equal(voice.generated.length,0);assert.ok(!pocketUsed(f));
  assert.ok(f.calls.includes('voice-language-note'),'the player is told once, on the Convai route too');
});

test('an English message keeps the chosen voice whatever the reply looks like: the characters\' Spanish slang is never muted',async()=>{
  const voice=multilingualVoice();
  const f=multilingualFixture({voiceSelection:voice,continuous:true,multilingual:multilingualOn()});
  f.input.text='How are you doing tonight, Judy?';
  f.remote.text=SPANISH_REPLY;
  const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
  assert.equal(sent(f).ttsEnabled,false);
  assert.ok(pocketUsed(f),'Pocket speaks it, as it always did');
  assert.equal(result.audioError,undefined);
});

test('a Spanish message answered in Spanish on Pocket publishes the written reply and sets the conversation language',async()=>{
  const voice=multilingualVoice();
  const f=multilingualFixture({voiceSelection:voice,continuous:true,multilingual:multilingualOn()});
  f.input.text='¿Qué tal, Judy? ¿Vamos al bar esta noche?';
  f.remote.text=SPANISH_REPLY;
  const result=await f.api.respond(f.input,f.profile,{current:async()=>true});
  await f.api.publishResult(f.input,f.profile,result,async()=>true);
  assert.equal(f.publications.find(([path])=>path==='reply.json')[1].text,SPANISH_REPLY);
  assert.equal(f.multilingual.lastLanguage,'es');
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

test('every Omni phrase of a turn, whatever renders it, uses the one picked variant', async () => {
  const generated = [], voice = variantVoice(['npc-fixer-male-v2', 'npc-fixer-male-v4', 'npc-fixer-male-v3']);
  voice.synthesize = async (key, text, options) => { generated.push(key);
    return {audio: wavOf(), faces: [], captions: [], timing: {voiceProvider: 'omnivoice'}}; };
  voice.provider = 'omni';
  const f = fixture({voiceSelection: voice, continuous: true}), current = async () => true;
  f.input = ambientTurn(); f.profile = {key: 'npc-fixer-male', name: 'Fixer'};
  f.remote.text = 'We have a long enough original sentence to produce the first local phrase. Then we have another long enough sentence for the following phrase.';
  const result = await f.api.respond(f.input, f.profile, {current});
  assert.deepEqual(f.calls.filter(value => Array.isArray(value) && value[0] === 'voice-stream').map(value => value[1]), ['npc-fixer-male-v2'], 'the voice is asked for by the picked variant');
  assert.equal(f.delivered[0].voiceKey, 'npc-fixer-male-v2');
  await f.api.publishResult(f.input, f.profile, result, current);
  assert.ok(generated.length >= 2); assert.ok(generated.every(key => key === 'npc-fixer-male-v2'), generated.join());
  assert.equal(voice.asked.length, 1);
  assert.equal(f.delivered[0].profile.key, 'npc-fixer-male', 'the delivery still names the profile');
});

test('a voice without variants keeps the profile key for every call', async () => {
  const generated = [], voice = {provider: 'omni', steps: 16, usesProfile: () => true, voiceKeyFor: profile => profile,
    async synthesize(key) { generated.push(key); return {audio: wavOf(), faces: [], captions: [], timing: {}}; }};
  const f = fixture({voiceSelection: voice, continuous: true});
  f.input = ambientTurn(); f.profile = {key: 'npc-fixer-male', name: 'Fixer'};
  await f.api.respond(f.input, f.profile, {current: async () => true});
  assert.ok(generated.length && generated.every(key => key === 'npc-fixer-male'));
});
