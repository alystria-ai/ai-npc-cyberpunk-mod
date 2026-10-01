import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {RealtimeHost} from './realtime-host.mjs';
import {TransportPool, endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';
import {drainBlendshapes} from './blendshape-capture.mjs';
import {PcmChunkStream} from './convai-audio-stream.mjs';
import {ConvaiDataAudio} from './convai-data-audio.mjs';
import {ConvaiEmotion} from './convai-emotion.mjs';
import {CompanionActionWindow, publishCompanionActionContext} from './companion-actions.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const flush = () => new Promise(done => setImmediate(done));
const config = {key: 'test-key', characterId: 'judy', endUserId: 'test-save', scope: 'phone', ttsEnabled: false, text: 'Hello'};
const clientSource = readFileSync(new URL('./realtime-client.mjs', import.meta.url), 'utf8')
  .replace("import {ConvaiClient} from '@convai/web-sdk/vanilla';", '')
  .replace("import {drainBlendshapes} from './blendshape-capture.mjs';", '')
  .replace("import {endUserOptions, transportKey, SessionBindings} from './transport-pool.mjs';", '')
  .replace("import {PcmChunkStream} from './convai-audio-stream.mjs';", '')
  .replace("import {ConvaiDataAudio} from './convai-data-audio.mjs';", '')
  .replace("import {ContinuousPcmPlayer} from './continuous-pcm-player.mjs';", '')
  .replace("import {ConvaiEmotion} from './convai-emotion.mjs';", '')
  .replace("import {CompanionActionWindow, publishCompanionActionContext} from './companion-actions.mjs';", '');

// Run the actual host and lease pool. Each page executes the host's browser
// callbacks against its own window, without launching a browser or SDK network.
function fixture(t, {disconnectTimeoutMs, realClient = false, onDisconnect, createError} = {}) {
  const events = [], pages = [], gates = [];
  const host = new RealtimeHost({disconnectTimeoutMs});
  const browser = {isConnected: () => true, async close() { events.push('browser-close'); }};
  const server = {close() { events.push('server-close'); }};
  host.browser = browser; host.server = server;
  host.start = async () => {};
  const gate = () => { const result = deferred(); gates.push(result); return result; };
  const pool = host.pool = new TransportPool({limit: 11,
    create: async key => {
      if (createError) throw createError;
      const label = 'page-' + pages.length;
      const page = {key, label, closed: false, calls: [], clients: [], closeOptions: [],
        isClosed() { return this.closed; },
        url: () => 'http://127.0.0.1:4321/',
        context: () => ({grantPermissions: async () => {}, clearPermissions: async () => {}}),
        async close(options) {
          this.closeOptions.push(options); events.push(label + ':page-close'); this.closed = true;
          if (this.failClose) throw Error('Page close failed');
        },
        async evaluate(fn, payload) {
          if (this.closed || this.failEvaluation) throw Error('Target page is closed');
          return runInNewContext('(' + fn.toString() + ')(payload)', {window: this.window, payload});
        }};
      const disconnect = async () => {
        events.push(label + ':sdk-disconnect:start');
        await onDisconnect?.(page);
        events.push(label + ':sdk-disconnect:done');
      };
      page.api = {
        warm: async request => { page.calls.push({method: 'warm', config: request}); return {sessionID: label + '-session'}; },
        reply: async request => { page.calls.push({method: 'reply', config: request}); return {text: 'Reply', sessionID: label + '-session', timing: {}}; },
        beginVoice: async request => { page.calls.push({method: 'beginVoice', config: request}); return {sessionID: label + '-voice-session'}; },
        finishVoice: async request => { page.calls.push({method: 'finishVoice', config: request}); return {text: 'Voice reply', sessionID: label + '-voice-session', timing: {}}; },
        close: async reason => { page.calls.push({method: 'close', reason}); await disconnect(); },
      };
      page.window = {convaiRealtime: page.api};
      if (realClient) {
        class Client {
          constructor(options) {
            this.options = options; this.characterId = options.characterId;
            this.characterSessionId = options.characterSessionId === '-1' ? label + '-sdk-session' : options.characterSessionId;
            this.state = {endUserId: options.endUserId ?? null, isThinking: false};
            this.handlers = new Map(); this.chatMessages = [];
            this.room = {on() {}, remoteParticipants: new Map(), localParticipant: {audioTrackPublications: new Map()}};
            page.clients.push(this);
          }
          on(name, handler) { this.handlers.set(name, handler); }
          async connect() { this.isBotReady = true; }
          async disconnect() { this.isBotReady = false; await disconnect(); }
          updateContext() {}
          sendUserTextMessage(text) {
            page.calls.push({method: 'message', text});
            this.handlers.get('messagesChange')([{id: 'answer', type: 'bot-llm-text', content: 'SDK reply', isStreaming: false}]);
          }
        }
        runInNewContext(clientSource, {ConvaiClient: Client, window: page.window,
          endUserOptions, transportKey, SessionBindings, drainBlendshapes, PcmChunkStream, ConvaiDataAudio, ConvaiEmotion,
          CompanionActionWindow, publishCompanionActionContext,
          TextDecoder, ArrayBuffer, Uint8Array,
          performance, setTimeout, clearTimeout, setInterval, clearInterval,
          btoa: data => Buffer.from(data, 'binary').toString('base64')});
        page.api = page.window.convaiRealtime;
      }
      pages.push(page); return page;
    },
    dispose: page => host.disposePage(page),
  });
  t.after(async () => {
    for (const pending of gates) pending.resolve();
    await host.close();
  });
  return {host, pool, browser, server, pages, events, gate};
}

test('explicitly discarded replies disconnect the SDK before closing and reconnect the retained session', async t => {
  const {host, pool, pages, events} = fixture(t, {realClient: true});
  const first = await host.reply(config, {discard: true});
  assert.equal(pool.entries.size, 0); assert.equal(pages[0].closed, true);
  assert(events.indexOf('page-0:sdk-disconnect:done') < events.indexOf('page-0:page-close'));
  assert.deepEqual(pages[0].closeOptions, [{runBeforeUnload: false}]);
  assert.equal(host.sessions.owners.has(first.sessionID), true);
  const second = await host.reply({...config, sessionId: first.sessionID}, {discard: true});
  assert.equal(pages.length, 2);
  assert.equal(pages[1].clients[0].options.characterSessionId, first.sessionID);
  assert.equal(second.sessionID, first.sessionID);
  assert.equal(pages[1].clients[0].options.endUserId, config.endUserId);
  assert.equal(host.sessions.owners.size, 1);
});

test('admitted phone replies reuse their scoped connection without waiting for teardown after every message', async t => {
  const {host, pool, pages, events} = fixture(t, {realClient: true});
  const first = await host.reply(config);
  assert.equal(pool.entries.size, 1); assert.equal(pages[0].closed, false);
  assert.equal(events.some(event => event.includes('sdk-disconnect')), false);
  const second = await host.reply({...config, sessionId: first.sessionID, text: 'And then?'});
  assert.equal(second.sessionID, first.sessionID);
  assert.equal(pages.length, 1); assert.equal(pages[0].clients.length, 1);
  assert.equal(second.timing.pageReused, true); assert.equal(second.timing.connectionReused, true);
  assert.equal(events.some(event => event.includes('sdk-disconnect')), false);
  await host.close();
  assert.equal(pages[0].closed, true);
  assert.equal(events.filter(event => event.endsWith(':sdk-disconnect:done')).length, 1);
});

test('retained phone sessions remain bound to their character, player and world/reset scope', async t => {
  const {host, pages} = fixture(t, {realClient: true});
  const first = await host.reply(config);
  for (const changed of [{characterId: 'panam'}, {endUserId: 'another-player'}, {scope: 'phone:next-world'}]) {
    await assert.rejects(host.reply({...config, ...changed, sessionId: first.sessionID}), /another user or scope/);
  }
  assert.equal(pages.length, 1, 'foreign session proposals never reach a new SDK connection');
  const other = await host.reply({...config, characterId: 'panam'});
  assert.equal(pages.length, 2); assert.notEqual(other.sessionID, first.sessionID);
  assert.equal((await host.reply({...config, sessionId: first.sessionID})).timing.connectionReused, true);
});

test('the admitted phone bridge route retains successful replies rather than discarding their connection', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const route = bridge.slice(bridge.indexOf('const result = await phoneRealtime.reply('), bridge.indexOf('stagedKnowledgeTurn(prepared);'));
  assert.match(route, /ttsEnabled: false/);
  assert.match(route, /signal: options\.signal/);
  assert.doesNotMatch(route, /discard\s*:\s*true/);
});

test('idle disposal awaits one SDK disconnect before page close', async t => {
  let disconnect;
  const {host, pool, pages, events, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  await host.warm(config);
  const page = pages[0];
  const disposing = host.refreshIdle(config);
  await flush();
  assert.equal(page.closed, false);
  assert.equal(pool.entries.size, 1, 'the retiring page remains counted until its disposal finishes');
  const first = host.disconnectPage(page), again = host.disconnectPage(page);
  assert.equal(first, again);
  assert.equal(page.calls.filter(call => call.method === 'close').length, 1);
  assert.equal(page.calls.find(call => call.method === 'close').reason, 'Conversation ended');
  disconnect.resolve();
  assert.equal(await disposing, true);
  assert.equal(pool.entries.size, 0);
  assert.deepEqual(events, ['page-0:sdk-disconnect:start', 'page-0:sdk-disconnect:done', 'page-0:page-close']);
});

test('host shutdown starts all eleven disconnects in parallel and uses one 2.5-second grace', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let disconnect;
  const {host, pool, pages, events, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  const party = Array.from({length: 11}, (_, index) => ({...config, characterId: 'companion-' + index}));
  for (const member of party) await host.warm(member);
  await host.retain(party, {protect: true});
  const waiting = assert.rejects(pool.acquire(transportKey({...config, characterId: 'queued'})), {name: 'AbortError'});
  await flush();
  const closing = host.close();
  assert.equal(host.close(), closing);
  assert.equal(pool.closed, true, 'shutdown fences acquisition before waiting for any SDK');
  await flush();
  assert.equal(events.filter(event => event.endsWith(':sdk-disconnect:start')).length, 11);
  assert.equal(pages.filter(page => page.closed).length, 0);
  assert.equal(events.includes('browser-close'), false);
  t.mock.timers.tick(2499); await flush();
  assert.equal(pages.filter(page => page.closed).length, 0);
  t.mock.timers.tick(1); await closing; await waiting;
  assert.equal(pages.filter(page => page.closed).length, 11);
  assert.equal(events.filter(event => event.endsWith(':sdk-disconnect:done')).length, 0);
  assert.equal(events.includes('browser-close'), true);
  assert.equal(events.includes('server-close'), true);
  assert.equal(pool.entries.size, 0);
  assert.equal(host.pool, null); assert.equal(host.browser, null);
  assert(pages.every(page => page.closeOptions.length === 1));
});

test('a hanging SDK close falls back to forced page disposal at the deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let disconnect;
  const {host, pages, events, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  await host.warm(config);
  const disposing = host.refreshIdle(config);
  await flush();
  t.mock.timers.tick(2499); await flush();
  assert.equal(pages[0].closed, false);
  t.mock.timers.tick(1);
  assert.equal(await disposing, true);
  assert.equal(pages[0].closed, true);
  assert.deepEqual(events, ['page-0:sdk-disconnect:start', 'page-0:page-close']);
  disconnect.resolve(); await flush();
  assert.equal(pages[0].closeOptions.length, 1, 'a late SDK completion cannot dispose the page again');
});

test('failed evaluations, failed page close and already closed pages do not strand shutdown', async t => {
  const {host, pool, pages, events} = fixture(t, {onDisconnect: page => {
    if (page === pages[0]) throw Error('SDK disconnect failed');
  }});
  for (let index = 0; index < 3; index++) await host.warm({...config, characterId: 'companion-' + index});
  pages[0].failClose = true; pages[1].closed = true; pages[2].failEvaluation = true;
  await host.close();
  assert.equal(pool.entries.size, 0);
  assert.deepEqual(pages.map(page => page.closeOptions.length), [1, 1, 1]);
  assert.equal(pages[1].calls.some(call => call.method === 'close'), false);
  assert.equal(pages[2].calls.some(call => call.method === 'close'), false);
  assert.equal(events.filter(event => event.endsWith(':sdk-disconnect:start')).length, 1);
  assert.equal(events.includes('browser-close'), true); assert.equal(events.includes('server-close'), true);
});

test('failed page creation retires its empty lease without invoking a missing page', async t => {
  const {host, pool, pages} = fixture(t, {createError: Error('Mock page creation failed')});
  await assert.rejects(host.warm({...config, sessionId: 'unverified-startup'}), /Mock page creation failed/);
  assert.equal(pool.entries.size, 0); assert.equal(pages.length, 0);
  assert.equal(host.sessions.owners.size, 0);
  await host.close();
});

for (const method of ['reply', 'warm']) {
  test('cancelled ' + method + ' evaluations cannot register supplied or late returned sessions', async t => {
    const {host, pool, pages, gate} = fixture(t);
    await host.warm(config);
    const owners = new Map(host.sessions.owners), started = gate(), response = gate();
    pages[0].api[method] = () => { started.resolve(); return response.promise; };
    const controller = new AbortController();
    const pending = host[method]({...config, sessionId: 'unverified-supplied'}, {signal: controller.signal});
    pending.catch(() => {});
    await started.promise; controller.abort();
    await assert.rejects(pending, {name: 'AbortError'});
    response.resolve({sessionID: 'late-returned', text: 'Obsolete reply', timing: {}}); await flush();
    assert.deepEqual(host.sessions.owners, owners);
    assert.equal(pool.entries.size, 0); assert.equal(pages[0].closed, true);
  });

  test('a ' + method + ' evaluation finishing after host shutdown cannot update session ownership', async t => {
    const {host, pages, gate} = fixture(t);
    await host.warm(config);
    const owners = new Map(host.sessions.owners), started = gate(), response = gate();
    pages[0].api[method] = () => { started.resolve(); return response.promise; };
    const pending = host[method]({...config, sessionId: 'unverified-supplied'}); pending.catch(() => {});
    await started.promise; await host.close();
    response.resolve({sessionID: 'late-returned', text: 'Obsolete reply', timing: {}});
    await assert.rejects(pending, {name: 'AbortError'});
    assert.deepEqual(host.sessions.owners, owners);
  });
}

test('cancelled voice startup cannot register its supplied or late returned session', async t => {
  const {host, pages, gate} = fixture(t);
  await host.warm(config);
  const owners = new Map(host.sessions.owners), started = gate(), response = gate();
  pages[0].api.beginVoice = () => { started.resolve(); return response.promise; };
  const channel = host.voiceChannel();
  const pending = channel.beginVoice({...config, sessionId: 'unverified-voice'}); pending.catch(() => {});
  await started.promise; await channel.close();
  response.resolve({sessionID: 'late-voice'});
  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(host.sessions.owners, owners);
  assert.equal(host.voiceLease, null);
});

test('a voice finish completing during host disconnect grace cannot register a stale session', async t => {
  let disconnect;
  const {host, pages, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  await host.beginVoice(config);
  const owners = new Map(host.sessions.owners), started = gate(), response = gate();
  pages[0].api.finishVoice = () => { started.resolve(); return response.promise; };
  const pending = host.finishVoice(); pending.catch(() => {});
  await started.promise;
  const closing = host.close();
  response.resolve({sessionID: 'stale-finished-voice', text: 'Obsolete reply', timing: {}});
  await flush();
  assert.deepEqual(host.sessions.owners, owners);
  disconnect.resolve(); await closing;
  await assert.rejects(pending, {name: 'AbortError'});
});

test('a voice finish requested after shutdown starts cannot invoke the page or register a session', async t => {
  let disconnect;
  const {host, pages, gate} = fixture(t, {onDisconnect: () => disconnect.promise});
  disconnect = gate();
  await host.beginVoice(config);
  const owners = new Map(host.sessions.owners);
  let evaluated = false;
  pages[0].api.finishVoice = async () => {
    evaluated = true;
    return {sessionID: 'finish-after-shutdown', text: 'Obsolete reply', timing: {}};
  };
  const closing = host.close(), pending = host.finishVoice(); pending.catch(() => {});
  await flush();
  assert.equal(evaluated, false, 'the retired lease must be rejected before browser evaluation');
  assert.deepEqual(host.sessions.owners, owners);
  disconnect.resolve(); await closing;
  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(host.sessions.owners, owners);
});
