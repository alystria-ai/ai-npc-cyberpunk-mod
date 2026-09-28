import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('./realtime-client.mjs', import.meta.url), 'utf8').replace("import {ConvaiClient} from '@convai/web-sdk/vanilla';", '');
const flush = () => new Promise(done => setImmediate(done));
function fixture() {
  const clients = [], events = [];
  class Client {
    constructor(options) {
      this.options = options; this.characterSessionId = 'session-' + clients.length;
      this.chatMessages = []; this.state = {}; this.blendshapeQueue = {length: 0, getPlaybackFps: () => 30, isConversationEnded: () => false};
      this.room = {on() {}, startAudio: async () => {}, remoteParticipants: new Map(),
        localParticipant: {audioTrackPublications: new Map()}};
      this.audioControls = {disableAudio: async () => {}, enableAudio: async () => { events.push('microphone'); }};
      clients.push(this);
    }
    on() {}
    async connect() { this.isBotReady = true; }
    async disconnect() { this.isBotReady = false; }
    updateContext(config) { events.push(['context', config]); }
    sendUserTextMessage(text) { events.push(['message', text]); }
    resetIdleTimer() { events.push('idle-reset'); }
  }
  class Audio {
    constructor() { this.audioWorklet = {addModule: async () => {}}; }
    async resume() {}
    async close() {}
  }
  class Capture { constructor() { this.port = {}; } connect() {} disconnect() {} }
  const window = {};
  runInNewContext(source, {ConvaiClient: Client, AudioContext: Audio, AudioWorkletNode: Capture,
    window, performance, setTimeout, clearTimeout, setInterval, clearInterval});
  return {api: window.convaiRealtime, clients, events};
}
const config = {key: 'test-key', characterId: 'alex', scope: 'group:alex,panam', text: 'Hello'};

test('warm is silent and an unused anonymous connection can prepare without reconnecting', async () => {
  const {api, clients, events} = fixture();
  await api.warm(config);
  const timing = await api.warm({...config, freshSession: true, sessionId: '-1'});
  assert.equal(clients.length, 1); assert.equal(timing.connectionReused, true);
  assert.deepEqual(events, []); // No prompt, generated reply, or microphone activation.
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
  assert.deepEqual(events, ['idle-reset']);
  await api.close(); assert.equal(api.readiness(true).ready, false);
  assert.deepEqual(events, ['idle-reset']);
});
