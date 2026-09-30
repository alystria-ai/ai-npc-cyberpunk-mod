import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {drainBlendshapes} from './blendshape-capture.mjs';
import {BlendshapeQueue} from '../node_modules/@convai/web-sdk/dist/core/BlendshapeQueue.js';
import {journalContext} from './quest-context.mjs';
import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';
import {PcmChunkStream} from './convai-audio-stream.mjs';

const source = readFileSync(new URL('./realtime-client.mjs', import.meta.url), 'utf8')
  .replace("import {ConvaiClient} from '@convai/web-sdk/vanilla';", '')
  .replace("import {drainBlendshapes} from './blendshape-capture.mjs';", '')
  .replace("import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';", '')
  .replace("import {PcmChunkStream} from './convai-audio-stream.mjs';", '');
const flush = () => new Promise(done => setImmediate(done));
function manualTimers() {
  let now = 0, nextId = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) { const id = ++nextId; pending.set(id, {callback, due: now + delay}); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...pending]) if (timer.due <= now) { pending.delete(id); timer.callback(); }
    }
  };
}
function fixture({emitAudio, allowMic = false, timers, onConnect, onDisconnect, onDisableAudio} = {}) {
  const clients = [], events = [], captures = [];
  class Client {
    constructor(options) {
      this.options = options; this.characterId = options.characterId;
      this.characterSessionId = 'session-' + clients.length; this.handlers = new Map();
      this.chatMessages = []; this.state = {endUserId: options.endUserId || null}; this.blendshapeQueue = {length: 0, getPlaybackFps: () => 30, isConversationEnded: () => false};
      this.room = {on() {}, startAudio: async () => {}, remoteParticipants: new Map(),
        localParticipant: {audioTrackPublications: new Map(), unpublishTrack: async () => this.room.localParticipant.audioTrackPublications.clear()}};
      this.audioControls = {disableAudio: async () => {
        if (allowMic) events.push('microphone-disable');
        await onDisableAudio?.(this);
      }, enableAudio: async () => {
        events.push('microphone');
        if (allowMic) {
          const track = {readyState: 'live', label: 'fixture microphone', stop() {
            if (this.readyState !== 'ended') events.push('microphone-stop');
            this.readyState = 'ended';
          }};
          this.room.localParticipant.audioTrackPublications.set('mic', {source: 'microphone', isMuted: false,
            track: {mediaStreamTrack: track}});
        }
      }};
      clients.push(this);
    }
    on(name, callback) { this.handlers.set(name, callback); }
    async connect() { await onConnect?.(this); this.isBotReady = true; }
    async disconnect() {
      this.isBotReady = false;
      if (allowMic) events.push(['disconnect', clients.indexOf(this)]);
      await onDisconnect?.(this);
    }
    sendInterruptMessage() { if (allowMic) events.push(['interrupt', clients.indexOf(this)]); }
    updateContext(config) { events.push(['context', config]); }
    sendUserTextMessage(text) { events.push(['message', text]); }
    sendTriggerMessage(name, text) { events.push(['trigger', name, text]); }
    resetIdleTimer() { events.push('idle-reset'); }
    toggleStt() {}
  }
  class Audio {
    constructor() { events.push('audio-capture'); this.sampleRate = 48000; this.audioWorklet = {addModule: async () => {}}; }
    async resume() {}
    async close() {}
  }
  class Capture { constructor() { this.port = {}; captures.push(this); } connect() {} disconnect() {} }
  const window = {__convaiAudioChunk: emitAudio};
  runInNewContext(source, {ConvaiClient: Client, AudioContext: Audio, AudioWorkletNode: Capture, drainBlendshapes,
    endUserOptions, transportKey, SessionBindings, PcmChunkStream,
    window, performance, setTimeout: timers?.setTimeout ?? setTimeout, clearTimeout: timers?.clearTimeout ?? clearTimeout,
    setInterval, clearInterval,
    btoa: data => Buffer.from(data, 'binary').toString('base64')});
  return {api: window.convaiRealtime, clients, events, captures};
}
const config = {key: 'test-key', characterId: 'alex', scope: 'group:alex,panam', text: 'Hello'};

test('automatic reactions send a game trigger without inventing a player utterance', async () => {
  const {api, events} = fixture();
  await api.warm({...config, ttsEnabled: false});
  const pending = api.reply({...config, ttsEnabled: false, reaction: {kind: 'battle', phase: 'start'}});
  pending.catch(() => {});
  await flush();
  assert.equal(events.some(row => row[0] === 'message'), false);
  assert.deepEqual(events.find(row => row[0] === 'trigger'), ['trigger', undefined, config.text]);
  await api.close(); await assert.rejects(pending, /cancelled/);
});

test('warm registration reports the actual SDK end-user echo and rejects missing or mismatched registration', async () => {
  const {api, clients} = fixture();
  const identified = {...config, ttsEnabled: false, endUserId: 'save-branch-user'};
  const first = await api.warm(identified);
  assert.equal(first.registration.verified, true);
  assert.equal(first.registration.endUserId, identified.endUserId);
  assert.equal(first.registration.characterId, config.characterId);
  assert.equal((await api.warm(identified)).connectionReused, true);
  clients[0].state.endUserId = null;
  await assert.rejects(api.warm(identified), /provider identity could not be verified/);
  assert.equal(clients[0].isBotReady, false);
  await api.warm(identified);
  clients[1].state.endUserId = 'another-user';
  await assert.rejects(api.warm(identified), /provider identity could not be verified/);
  assert.equal(clients[1].isBotReady, false);
  await api.close();
  assert.equal((await api.warm({...config, ttsEnabled: false})).registration.verified, false);
  await api.close();
});

test('new and reused anonymous connections require explicit SDK null instead of normalizing an invalid identity', async () => {
  for (const reuse of [false, true]) for (const echo of ['foreign-provider-user', '', ' ', 0, false, {}, [], undefined]) {
    const {api, clients, events} = fixture({onConnect: connection => {
      if (!reuse) connection.state.endUserId = echo;
    }});
    const anonymous = {...config, ttsEnabled: false};
    if (reuse) { await api.warm(anonymous); clients[0].state.endUserId = echo; }
    await assert.rejects(api.warm(anonymous), error => error.message === 'Convai provider identity could not be verified');
    assert.equal(clients[0].isBotReady, false); assert.equal(api.readiness().ready, false);
    assert.equal(Object.hasOwn(clients[0].options, 'endUserId'), false);
    assert.deepEqual(events, []);
    await api.close();
  }
});

test('provider identity rejection precedes text, reactions, prepared input and microphone startup', async () => {
  for (const reuse of [false, true]) for (const mode of ['reply', 'reaction', 'prepared', 'beginVoice']) {
    const {api, clients, events} = fixture({allowMic: true, onConnect: connection => {
      if (!reuse) connection.state.endUserId = 'unexpected-user';
    }});
    const anonymous = {...config, ttsEnabled: false};
    if (reuse) { await api.warm(anonymous); clients[0].state.endUserId = 'unexpected-user'; }
    const method = mode === 'beginVoice' ? mode : 'reply';
    const extra = mode === 'reaction' ? {reaction: {kind: 'battle'}} : mode === 'prepared' ? {freshSession: true, sessionId: '-1'} : {};
    await assert.rejects(api[method]({...anonymous, ...extra}), /provider identity could not be verified/);
    assert.equal(events.includes('microphone'), false);
    assert.equal(events.some(row => Array.isArray(row) && ['context', 'message', 'trigger'].includes(row[0])), false);
    assert.equal(clients[0].isBotReady, false);
    await api.close();
  }
});

test('dedicated identified registration requires the exact provider user and character on newly ready connections', async () => {
  for (const change of [connection => { connection.state.endUserId = null; },
    connection => { connection.state.endUserId = 'different-user'; },
    connection => { connection.characterId = 'different-character'; },
    connection => { connection.characterId = undefined; }]) {
    const {api, clients, events} = fixture({onConnect: change});
    await assert.rejects(api.warm({...config, ttsEnabled: false, endUserId: 'approved-registration-user'}),
      error => error.message === 'Convai provider identity could not be verified');
    assert.equal(clients[0].isBotReady, false); assert.deepEqual(events, []);
    await api.close();
  }
  const {api, clients} = fixture();
  await api.warm({...config, ttsEnabled: false});
  clients[0].characterId = 'different-character';
  await assert.rejects(api.warm({...config, ttsEnabled: false}), /provider identity could not be verified/);
  await api.close();
});

test('rejected startup does not record its supplied or returned session as a verified owner', async () => {
  for (const sessionId of ['rejected-supplied-session', 'rejected-returned-session']) {
    let connects = 0;
    const {api, clients} = fixture({onConnect: connection => {
      if (++connects === 1) {
        connection.state.endUserId = 'wrong-user';
        connection.characterSessionId = 'rejected-returned-session';
      }
    }});
    await assert.rejects(api.warm({...config, ttsEnabled: false, sessionId: 'rejected-supplied-session'}), /provider identity/);
    const receipt = await api.warm({...config, ttsEnabled: false, endUserId: 'approved-registration-user', sessionId});
    assert.equal(receipt.registration.verified, true); assert.equal(clients.length, 2);
    await api.close();
  }
});

test('delayed identity rejection closes its exact connection without clearing a later valid owner', async () => {
  let releaseDisconnect;
  const delayed = new Promise(done => { releaseDisconnect = done; });
  const {api, clients} = fixture({onDisconnect: connection => connection === clients[0] ? delayed : undefined});
  const anonymous = {...config, ttsEnabled: false};
  await api.warm(anonymous); clients[0].state.endUserId = 'wrong-user';
  const rejected = api.warm(anonymous); rejected.catch(() => {});
  await flush();
  const current = await api.warm({...anonymous, characterId: 'panam'});
  assert.equal(current.ready, true);
  releaseDisconnect(); await assert.rejects(rejected, /provider identity/);
  assert.equal(clients[1].isBotReady, true); assert.equal(api.readiness().ready, true);
  assert.equal((await api.warm({...anonymous, characterId: 'panam'})).connectionReused, true);
  await api.close();
});

test('microphone finish cancels a provider identity drift before refreshed context or audio submission', async () => {
  const {api, clients, events} = fixture({allowMic: true});
  const anonymous = {...config, ttsEnabled: false, context: 'Recording context.'};
  await api.beginVoice(anonymous);
  clients[0].state.endUserId = 'unexpected-user';
  await assert.rejects(api.finishVoice({...anonymous, context: 'Finish context.'}), /provider identity/);
  assert.equal(events.includes('microphone-disable'), false);
  assert.equal(events.filter(row => Array.isArray(row) && row[0] === 'context').length, 1);
  assert.equal(events.includes('microphone-stop'), true); assert.equal(api.readiness().ready, false);
  await api.close();
});

test('idle readiness never reports or keeps alive a connection whose verified provider identity changed', async () => {
  for (const identified of [false, true]) {
    const {api, clients, events} = fixture();
    await api.warm({...config, ttsEnabled: false, ...(identified ? {endUserId: 'registration-user'} : {})});
    assert.equal(api.readiness(true).ready, true);
    clients[0].state.endUserId = 'changed-provider-user';
    assert.equal(api.readiness(true).ready, false);
    await flush();
    assert.equal(clients[0].isBotReady, false);
    assert.deepEqual(events, ['idle-reset']);
    await api.close();
  }
});

test('captured Convai audio reaches the native sink before the remote utterance finishes', async () => {
  const chunks = [];
  const {api, clients, captures} = fixture({emitAudio: async (token, chunk) => {
    assert.equal(token, 'native-stream-one'); chunks.push(chunk);
  }});
  await api.warm(config);
  const pending = api.reply({...config, audioStreamToken: 'native-stream-one'}); pending.catch(() => {});
  await flush();
  const client = clients[0], queue = client.blendshapeQueue = new BlendshapeQueue();
  queue.startConversation();
  queue.addChunk(Array.from({length: 90}, (_, index) => Array(61).fill(index / 100)),
    {fps: 30, startFrameIndex: 0, responseId: 'spoken'});
  queue.startBotSpeaking(); client.state.isSpeaking = true;
  client.handlers.get('messagesChange')([{id: 'reply', type: 'bot-llm-text', content: 'Hello V. There is more to say.', isStreaming: false}]);
  captures[0].port.onmessage({data: {at: 10, pcm: new Float32Array(96000).fill(.1)}});
  await new Promise(done => setTimeout(done, 80));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].duration, 1);
  assert.equal(chunks[0].startSeconds, 0);
  assert.equal(chunks[0].text, 'Hello V. There is more to say.');
  assert.equal(chunks[0].faces[0].at, 0);
  assert.equal(chunks[0].faces.at(-1).at, 1);
  let finished = false; pending.then(() => { finished = true; });
  await flush(); assert.equal(finished, false);
  captures[0].port.onmessage({data: {at: 12, pcm: new Float32Array(48000).fill(.2)}});
  queue.stopBotSpeaking(); client.state.isSpeaking = false;
  queue.endConversation({fps: 30, total_blendshapes: 90, total_audio_duration_ms: 3000}, {responseId: 'spoken'});
  const result = await pending;
  assert.equal(chunks.length, 3);
  assert.equal(chunks[1].duration, 1); assert.equal(chunks[1].startSeconds, 1);
  assert(Math.abs(chunks[1].faces[0].values[0] - .3) < 1e-6);
  assert.equal(result.streamed, true); assert.equal(result.stream.chunks, 3); assert.equal(result.stream.duration, 3);
  assert.equal(result.audio, undefined); assert.equal(result.faces.length, 0);
  await api.close();
});

test('microphone stop refreshes context on its original connection before disabling the device', async () => {
  const {api, clients, events} = fixture({allowMic: true});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private', context: 'Earlier journal.'};
  const opened = await api.beginVoice(original);
  assert.equal(opened.sessionID, clients[0].characterSessionId);
  const pending = api.finishVoice({...original, sessionId: opened.sessionID, context: 'Newly verified objective.'});
  await flush();
  const contexts = events.filter(row => Array.isArray(row) && row[0] === 'context');
  assert.match(contexts.at(-1)[1].text, /Newly verified objective/);
  assert(events.lastIndexOf(contexts.at(-1)) < events.indexOf('microphone-stop'));
  assert.equal(clients.length, 1);
  clients[0].handlers.get('messagesChange')([{id: 'voice-reply', type: 'bot-llm-text', content: 'I know the current objective.', isStreaming: false}]);
  assert.equal((await pending).text, 'I know the current objective.');
  await api.close();
});

test('only the game finish submits speech after 30 seconds, with fresh context before disabling audio', async () => {
  const timers = manualTimers(), {api, clients, events} = fixture({allowMic: true, timers});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private', context: 'Earlier objective.'};
  const opened = await api.beginVoice(original);
  const obsoleteCeiling = [...timers.pending.values()][0].callback;
  timers.advance(30000); await flush();
  timers.advance(2000); await flush();
  assert.equal(events.includes('microphone-disable'), false);
  assert.equal(events.includes('microphone-stop'), false);
  assert.equal(api.readiness().ready, true);
  const pending = api.finishVoice({...original, sessionId: opened.sessionID, context: 'Verified at game finish.'});
  await flush();
  const latestContext = events.findLast(row => Array.isArray(row) && row[0] === 'context');
  assert.match(latestContext[1].text, /Verified at game finish/);
  assert(events.indexOf(latestContext) < events.indexOf('microphone-disable'));
  assert.equal(timers.pending.size, 0);
  // A queued callback can still run after clearTimeout; ownership and recording
  // state must also make it harmless while the reply is being collected.
  obsoleteCeiling(); timers.advance(3000); await flush();
  assert.equal(api.readiness().ready, true);
  assert.equal(events.some(row => Array.isArray(row) && row[0] === 'disconnect'), false);
  await assert.rejects(api.finishVoice(original), /No microphone conversation is recording/);
  clients[0].handlers.get('messagesChange')([{id: 'reply', type: 'bot-llm-text', content: 'Fresh reply.', isStreaming: false}]);
  assert.equal((await pending).text, 'Fresh reply.');
  assert.equal(events.filter(row => row === 'microphone-disable').length, 1);
  await api.close();
});

test('an abandoned microphone cancels at 35 seconds without submitting or collecting its recording', async () => {
  const timers = manualTimers(), {api, clients, events} = fixture({allowMic: true, timers});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private'};
  await api.beginVoice(original);
  const track = clients[0].room.localParticipant.audioTrackPublications.get('mic').track.mediaStreamTrack;
  timers.advance(34999); await flush();
  assert.equal(track.readyState, 'live');
  timers.advance(1); await flush();
  assert.equal(track.readyState, 'ended');
  assert.equal(api.readiness().ready, false);
  assert.equal(events.includes('microphone-disable'), false);
  const interrupted = events.findIndex(row => Array.isArray(row) && row[0] === 'interrupt');
  const disconnected = events.findIndex(row => Array.isArray(row) && row[0] === 'disconnect');
  assert(interrupted >= 0 && interrupted < disconnected && disconnected < events.indexOf('microphone-stop'));
  assert.equal(events.filter(row => Array.isArray(row) && row[0] === 'context').length, 1);
  clients[0].handlers.get('messagesChange')([{id: 'late', type: 'bot-llm-text', content: 'Unverified reply.', isStreaming: false}]);
  await assert.rejects(api.finishVoice(original), /No microphone conversation is recording/);
  assert.equal(timers.pending.size, 0);
  await api.close();
});

test('late cancellation shutdown and its old timer cannot stop a new recording', async () => {
  let releaseDisconnect;
  const delayed = new Promise(done => { releaseDisconnect = done; });
  const timers = manualTimers(), {api, clients, events} = fixture({allowMic: true, timers,
    onDisconnect: connection => connection === clients[0] ? delayed : undefined});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private'};
  await api.beginVoice(original);
  const oldCeiling = [...timers.pending.values()][0].callback;
  const oldTrack = clients[0].room.localParticipant.audioTrackPublications.get('mic').track.mediaStreamTrack;
  timers.advance(35000); await flush();
  assert.equal(oldTrack.readyState, 'ended', 'network shutdown cannot delay local microphone stop');
  await api.beginVoice({...original, endUserId: 'another-save'});
  const newTrack = clients[1].room.localParticipant.audioTrackPublications.get('mic').track.mediaStreamTrack;
  releaseDisconnect(); oldCeiling(); await flush();
  assert.equal(newTrack.readyState, 'live');
  assert.equal(api.readiness().ready, true);
  assert.equal(timers.pending.size, 1);
  assert.equal(events.includes('microphone-disable'), false);
  assert.equal(events.filter(row => Array.isArray(row) && row[0] === 'disconnect').length, 1);
  await api.close();
});

test('a cancelled finish cannot collect a new recording after delayed microphone disable', async () => {
  let releaseDisable;
  const delayed = new Promise(done => { releaseDisable = done; });
  const timers = manualTimers(), {api, clients} = fixture({allowMic: true, timers,
    onDisableAudio: connection => connection === clients[0] ? delayed : undefined});
  const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private'};
  await api.beginVoice(original);
  const finishing = api.finishVoice(original); finishing.catch(() => {});
  await api.close();
  await api.beginVoice({...original, endUserId: 'another-save'});
  releaseDisable();
  await assert.rejects(finishing, /Microphone finish cancelled/);
  assert.equal(clients[1].room.localParticipant.audioTrackPublications.get('mic').track.mediaStreamTrack.readyState, 'live');
  assert.equal(api.readiness().ready, true); assert.equal(timers.pending.size, 1);
  await api.close();
});

test('microphone stop cannot change its character, user, audience, TTS route or session', async () => {
  for (const change of [{characterId: 'panam'}, {endUserId: 'another-save'}, {scope: 'group:judy,panam'},
    {ttsEnabled: true}, {sessionId: 'foreign-session'}, {freshSession: true}]) {
    const {api, clients, events} = fixture({allowMic: true});
    const original = {...config, ttsEnabled: false, endUserId: 'one-save', scope: 'private'};
    await api.beginVoice(original);
    await assert.rejects(api.finishVoice({...original, ...change}), /identity changed|speculative preparation/);
    assert.equal(clients.length, 1);
    assert.equal(events.filter(row => Array.isArray(row) && row[0] === 'context').length, 1);
    await api.close();
  }
});

test('a turn silently replaces journal context before sending the original user message', async () => {
  const {api, events} = fixture();
  await api.warm(config);
  const journal = {version: 1, status: 'active', quest: {id: '1', title: 'Visible quest',
    objectives: [{id: '2', text: 'Meet a friend.', tracked: true}]}};
  const pending = api.reply({...config, context: journalContext(journal)}); pending.catch(() => {});
  await flush();
  const row = events.find(event => event[0] === 'context')[1];
  assert.equal(row.mode, 'replace'); assert.equal(row.run_llm, 'false');
  assert.match(row.text, /Visible quest/); assert.match(row.text, /active, revealed objectives/);
  assert.doesNotMatch(row.text, /No verified quest/);
  assert(events.findIndex(event => event[0] === 'context') < events.findIndex(event => event[0] === 'message'));
  assert.equal(events.find(event => event[0] === 'message')[1], config.text);
  await api.close(); await assert.rejects(pending, /cancelled/);
});

test('warm is silent and an unused anonymous connection can prepare without reconnecting', async () => {
  const {api, clients, events} = fixture();
  await api.warm(config);
  const timing = await api.warm({...config, freshSession: true, sessionId: '-1'});
  assert.equal(clients.length, 1); assert.equal(timing.connectionReused, true);
  assert.deepEqual(events, ['audio-capture']); // No prompt, generated reply, or microphone activation.
  assert.equal(clients[0].options.startWithAudioOn, false);
  assert.equal(clients[0].options.characterSessionId, '-1');
  await api.close();
});

test('an attempted turn makes a page ineligible for isolated preparation even when cancelled', async () => {
  const {api, clients, events} = fixture();
  await api.warm(config);
  const pending = api.reply(config); pending.catch(() => {});
  await flush(); assert.equal(events.some(row => row[0] === 'message'), true);
  await api.warm({...config, freshSession: true, sessionId: '-1'});
  await assert.rejects(pending, /cancelled/);
  assert.equal(clients.length, 2); assert.equal(clients[1].options.characterSessionId, '-1');
  assert.equal(events.includes('microphone'), false);
  const context = events.find(row => row[0] === 'context')[1];
  assert.equal(context.run_llm, 'false');
  await api.close();
});

test('isolated preparation never reuses a supplied persistent session or carries it through close', async () => {
  const {api, clients} = fixture();
  await api.warm({...config, sessionId: 'persistent-session'});
  await api.warm({...config, sessionId: '-1', freshSession: true});
  assert.equal(clients.length, 2); assert.equal(clients[1].options.characterSessionId, '-1');
  await api.close();
  await api.warm(config);
  assert.equal(clients[2].options.characterSessionId, '-1');
  await api.close();
});

test('party keepalive resets only the service idle timer without dialogue or microphone', async () => {
  const {api, events} = fixture(); await api.warm(config);
  assert.equal(api.readiness(true).ready, true);
  assert.deepEqual(events, ['audio-capture', 'idle-reset']);
  await api.close(); assert.equal(api.readiness(true).ready, false);
  assert.deepEqual(events, ['audio-capture', 'idle-reset']);
});

test('text-only replies finish on LLM completion without audio, lipsync or microphone', async () => {
  const {api, clients, events} = fixture();
  await api.warm({...config, ttsEnabled: false});
  const pending = api.reply({...config, ttsEnabled: false});
  await flush();
  const client = clients[0];
  assert.equal(client.options.ttsEnabled, false);
  assert.equal(client.options.enableLipsync, false);
  client.chatMessages = [{id: 'answer', type: 'bot-llm-text', content: 'Hello V.', isStreaming: true}];
  client.state.isThinking = true;
  client.handlers.get('messagesChange')(client.chatMessages);
  let completed = false; pending.then(() => { completed = true; });
  await new Promise(done => setTimeout(done, 80));
  assert.equal(completed, false);
  client.chatMessages[0].isStreaming = false;
  client.state.isThinking = false;
  client.handlers.get('messagesChange')(client.chatMessages);
  const result = await pending;
  assert.equal(result.text, 'Hello V.'); assert.equal(result.audio, undefined);
  assert.equal(events.includes('audio-capture'), false);
  assert.equal(events.includes('microphone'), false);
  await api.close();
});

test('switching between native Convai voice and local speech reconnects the session with correct TTS flag', async () => {
  const {api, clients} = fixture();
  await api.warm(config);
  await api.warm({...config, ttsEnabled: false});
  assert.equal(clients.length, 2);
  assert.equal(clients[0].isBotReady, false);
  assert.equal(clients[1].options.ttsEnabled, false);
  await api.close();
});

test('spawn warmup supplies verified identity and metadata before connecting, while absent identity stays anonymous', async () => {
  const {api, clients, events} = fixture();
  const identified = {...config, ttsEnabled: false, endUserId: 'opaque-user-a-branch-one',
    endUserMetadata: {app: 'cyberpunk-convai', schema: 'memory-v1'}};
  await api.warm(identified);
  assert.equal(clients[0].options.endUserId, identified.endUserId);
  assert.equal(clients[0].options.endUserMetadata, identified.endUserMetadata);
  assert.equal(clients[0].options.characterSessionId, '-1');
  assert.equal((await api.warm(identified)).connectionReused, true);
  assert.equal(clients.length, 1);
  assert.deepEqual(events, []);
  await api.warm({...config, ttsEnabled: false, endUserMetadata: {ignored: true}});
  assert.equal(clients.length, 2);
  assert.equal(clients[0].isBotReady, false);
  assert.equal(Object.hasOwn(clients[1].options, 'endUserId'), false);
  assert.equal(Object.hasOwn(clients[1].options, 'endUserMetadata'), false);
  await api.close();
});

test('a session cannot move to another user, save branch or audience, while its TTS route may change', async () => {
  const {api, clients} = fixture();
  const identified = {...config, ttsEnabled: false, endUserId: 'opaque-user-a-branch-one'};
  await api.warm(identified);
  const sessionId = clients[0].characterSessionId;
  for (const change of [{endUserId: 'opaque-user-b'}, {endUserId: 'opaque-user-a-branch-two'},
    {endUserId: undefined}, {scope: 'private'}]) {
    await assert.rejects(api.warm({...identified, ...change, sessionId}), /another user or scope/);
  }
  assert.equal(clients.length, 1);
  assert.equal(clients[0].isBotReady, true);
  await api.warm({...identified, sessionId, ttsEnabled: true});
  assert.equal(clients.length, 2);
  assert.equal(clients[1].options.characterSessionId, sessionId);
  assert.equal(clients[1].options.endUserId, identified.endUserId);
  await api.close();
});

test('identified preparation is rejected before connecting or sending speculative dialogue', async () => {
  const {api, clients, events} = fixture();
  const unsafe = {...config, endUserId: 'opaque-user-a', freshSession: true, sessionId: '-1'};
  await assert.rejects(api.warm(unsafe), /cannot use speculative preparation/);
  await assert.rejects(api.reply(unsafe), /cannot use speculative preparation/);
  assert.equal(clients.length, 0); assert.deepEqual(events, []);
});

test('late SDK events from a disconnected user cannot populate or fail the next user conversation', async () => {
  const {api, clients} = fixture();
  const first = {...config, ttsEnabled: false, endUserId: 'opaque-user-a'};
  await api.warm(first);
  const obsolete = api.reply(first); obsolete.catch(() => {});
  await flush();
  const second = {...first, endUserId: 'opaque-user-b'};
  await api.warm(second);
  await assert.rejects(obsolete, /cancelled/);
  const pending = api.reply(second); await flush();
  clients[0].handlers.get('messagesChange')([{id: 'old', type: 'bot-llm-text', content: 'Private to the other user.', isStreaming: false}]);
  for (const event of ['error', 'disconnect', 'llmNoResponse']) clients[0].handlers.get(event)();
  clients[0].handlers.get('botOutput')({text: 'Old caption', spoken: true});
  let finished = false; pending.then(() => { finished = true; });
  await new Promise(done => setTimeout(done, 80));
  assert.equal(finished, false);
  clients[1].handlers.get('messagesChange')([{id: 'new', type: 'bot-llm-text', content: 'Only the current reply.', isStreaming: false}]);
  assert.equal((await pending).text, 'Only the current reply.');
  assert.equal(clients[1].options.characterSessionId, '-1');
  await api.close();
});

test('context permits explicit current-save relationships while keeping unsupplied relationships unknown', async () => {
  const {api, clients, events} = fixture();
  const request = {...config, ttsEnabled: false, context: 'Current-save verified fact: Judy and V are friends.'};
  await api.warm(request);
  const pending = api.reply(request); await flush();
  const context = events.find(row => row[0] === 'context')[1];
  assert.match(context.text, /explicitly supplied current-save facts for quest progress and relationships/);
  assert.match(context.text, /not explicitly supplied is unknown/);
  assert.match(context.text, /Current-save verified fact: Judy and V are friends\./);
  assert.doesNotMatch(context.text, /No verified relationship state is supplied/);
  assert.equal(context.mode, 'replace'); assert.equal(context.run_llm, 'false');
  clients[0].handlers.get('messagesChange')([{id: 'reply', type: 'bot-llm-text', content: 'Hey, friend.', isStreaming: false}]);
  await pending; await api.close();
});

test('ahead-delivered facial frames do not end a reply before its actual audio finishes', async () => {
  const {api, clients, captures} = fixture();
  await api.warm(config);
  const pending = api.reply(config); await flush();
  const client = clients[0], queue = client.blendshapeQueue = new BlendshapeQueue();
  queue.startConversation();
  queue.addChunk(Array.from({length: 60}, () => Array(61).fill(0.3)),
    {fps: 30, startFrameIndex: 0, responseId: 'spoken'});
  queue.endConversation({fps: 30, total_blendshapes: 60, total_audio_duration_ms: 2000}, {responseId: 'spoken'});
  client.handlers.get('messagesChange')([{id: 'reply', type: 'bot-llm-text', content: 'Hello V.', isStreaming: false}]);
  let finished = false; pending.then(() => { finished = true; });
  await new Promise(done => setTimeout(done, 80));
  assert.equal(queue.length, 0); assert.equal(finished, false);
  queue.startBotSpeaking(); client.state.isSpeaking = true;
  const pcm = new Float32Array(48000).fill(0.1);
  captures[0].port.onmessage({data: {at: 10, pcm}});
  await new Promise(done => setTimeout(done, 80));
  assert.equal(finished, false);
  captures[0].port.onmessage({data: {at: 11, pcm}});
  queue.stopBotSpeaking(); client.state.isSpeaking = false;
  const result = await pending;
  assert.equal(result.faces.length, 60); assert.equal(result.facesFormat, 'arkit61');
  assert.equal(result.faces[59].at, 59 / 30); assert.equal(result.facesTimebase, 'audio-seconds');
  assert.equal(Buffer.from(result.audio, 'base64').readUInt32LE(40), 96000 * 2);
  await api.close();
});
