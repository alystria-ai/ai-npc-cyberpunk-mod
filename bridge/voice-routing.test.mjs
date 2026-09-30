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
  + section('async function respond(', 'const micPath =');
function fixture({local = false, available = true, audioFailure = false} = {}) {
  const calls = [], publications = [];
  const remote = {text: 'A complete reply. With two sentences.', sessionID: 'test-session',
    audio: silentWav().toString('base64'), faces: [{at: 0, values: [0.2]}],
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds', timing: {audioRoute: 'convai-data-only'}};
  const sandbox = {remote, calls, publications, runtime: 'test-runtime', replyPath: 'reply.json',
    localVoice: {usesProfile: () => local, steps: 32},
    splitSpeechText: text => { calls.push('split'); return ['A complete reply.', 'With two sentences.']; },
    synthesizePhrase: async (profile, text) => { calls.push('local:' + text); return {audio: 'local-wav', timing: {voiceProvider: 'omni'}}; },
    throwIfCancelled: () => {}, audioReady: async () => available,
    realtimeConfig: input => ({profileKey: input.profileKey, text: input.text, ttsEnabled: !local}),
    realtime: {reply: async config => { calls.push(['send', config]); return config.ttsEnabled ? remote : {...remote, audio: undefined}; }},
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
  };
  runInNewContext(code + ';globalThis.api={respond,publishResult};', sandbox);
  return {...sandbox, input: {requestId: 'r1', generation: 1, entity: 'e1', profileKey: 'judy', text: 'Hello'},
    profile: {key: 'judy', name: 'Judy'}};
}

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
