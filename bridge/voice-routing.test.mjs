import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {silentWav} from './speech-audio.mjs';

// Execute the production routing/publication functions. These checks catch a
// future shared batching path accidentally processing remote Convai speech.
const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const code = section('async function synthesizeReply(', 'async function synthesizePhrase(')
  + section('function continuousSpeech(', 'async function respond(')
  + section('async function respond(', 'const micPath =');
function fixture({local = false, available = true, audioFailure = false, continuous = false} = {}) {
  const calls = [], publications = [];
  const remote = {text: 'A complete reply. With two sentences.', sessionID: 'test-session',
    audio: silentWav().toString('base64'), faces: [{at: 0, values: [0.2]}],
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds', timing: {audioRoute: 'convai-data-only'}};
  const sandbox = {remote, calls, publications, runtime: 'test-runtime', replyPath: 'reply.json',
    localVoice: {usesProfile: () => local, steps: 32},
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
    realtimeConfig: input => ({profileKey: input.profileKey, text: input.text, ttsEnabled: !local}),
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
