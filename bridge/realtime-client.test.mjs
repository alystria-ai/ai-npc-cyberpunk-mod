import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {drainBlendshapes} from './blendshape-capture.mjs';
import {BlendshapeQueue} from '../node_modules/@convai/web-sdk/dist/core/BlendshapeQueue.js';
import {journalContext} from './quest-context.mjs';
import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';

const source = readFileSync(new URL('./realtime-client.mjs', import.meta.url), 'utf8')
  .replace("import {ConvaiClient} from '@convai/web-sdk/vanilla';", '')
  .replace("import {drainBlendshapes} from './blendshape-capture.mjs';", '')
  .replace("import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';", '');
const flush = () => new Promise(done => setImmediate(done));
function fixture() {
  const clients = [], events = [], captures = [];
  class Client {
    constructor(options) {
      this.options = options; this.characterSessionId = 'session-' + clients.length; this.handlers = new Map();
      this.chatMessages = []; this.state = {}; this.blendshapeQueue = {length: 0, getPlaybackFps: () => 30, isConversationEnded: () => false};
      this.room = {on() {}, startAudio: async () => {}, remoteParticipants: new Map(),
        localParticipant: {audioTrackPublications: new Map()}};
      this.audioControls = {disableAudio: async () => {}, enableAudio: async () => { events.push('microphone'); }};
      clients.push(this);
    }
    on(name, callback) { this.handlers.set(name, callback); }
    async connect() { this.isBotReady = true; }
    async disconnect() { this.isBotReady = false; }
    updateContext(config) { events.push(['context', config]); }
    sendUserTextMessage(text) { events.push(['message', text]); }
    sendTriggerMessage(name, text) { events.push(['trigger', name, text]); }
    resetIdleTimer() { events.push('idle-reset'); }
  }
  class Audio {
    constructor() { events.push('audio-capture'); this.sampleRate = 48000; this.audioWorklet = {addModule: async () => {}}; }
    async resume() {}
    async close() {}
  }
  class Capture { constructor() { this.port = {}; captures.push(this); } connect() {} disconnect() {} }
  const window = {};
  runInNewContext(source, {ConvaiClient: Client, AudioContext: Audio, AudioWorkletNode: Capture, drainBlendshapes,
    endUserOptions, transportKey, SessionBindings,
    window, performance, setTimeout, clearTimeout, setInterval, clearInterval,
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
