import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {RealtimeHost} from './realtime-host.mjs';
import {TransportPool} from './transport-pool.mjs';

const config = {key: 'offline-test-key', characterId: 'judy', endUserId: 'offline-player',
  scope: 'private:offline-world', ttsEnabled: true, text: 'Hello'};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
};
const flush = () => new Promise(done => setImmediate(done));
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, message, timeout = 1500) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await sleep(5);
  }
}
const playbackControl = {allow: true, paused: false, volume: 0.75, pan: -0.2};

// Run the real host and lease pool against independent fake browser windows.
// No browser startup, provider request, real microphone permission, or audio
// device is reachable through this fixture. A reply resolves only when its
// synthetic renderer's drain gate is released by the test.
function fixture(t) {
  const host = new RealtimeHost({disconnectTimeoutMs: 25}), pages = [], gates = [];
  const pendingTurns = [];
  // node:test timeouts are unref'ed. Keep this offline fixture alive when a
  // broken implementation leaves a reply pending without starting its pump.
  const watchdog = setInterval(() => {}, 100);
  const gate = () => { const item = deferred(); gates.push(item); return item; };
  const track = promise => { pendingTurns.push(promise); promise.catch(() => {}); return promise; };
  host.start = async () => {};
  host.browser = {isConnected: () => true, close: async () => {}};
  host.pool = new TransportPool({limit: 3, create: async key => {
    const page = {key, label: `page-${pages.length}`, closed: false, calls: [], controls: [],
      snapshots: [], permissions: [], started: gate(), drained: gate(), activeToken: null,
      isClosed() { return this.closed; },
      url: () => 'http://127.0.0.1:4321/',
      context() { return {
        grantPermissions: async names => { this.permissions.push(['grant', names]); },
        clearPermissions: async () => { this.permissions.push(['clear']); },
      }; },
      async close() { this.closed = true; this.activeToken = null; },
      async evaluate(fn, payload) {
        if (this.closed) throw Error('Target page is closed');
        return runInNewContext(`(${fn.toString()})(payload)`, {window: this.window, payload});
      },
      finish() { this.finished = true; this.drained.resolve({text: 'Reply', sessionID: this.label + '-session',
        timing: {}, audio: null, streamed: true}); },
    };
    const runReply = (method, request) => {
      page.calls.push({method, config: request});
      page.activeToken = request?.liveSpeechToken ?? null;
      page.started.resolve();
      return page.drained.promise;
    };
    page.window = {convaiRealtime: {
      reply: request => runReply('reply', request),
      warm: async request => {
        page.calls.push({method: 'warm', config: request});
        return {sessionID: page.label + '-session'};
      },
      beginVoice: async request => {
        page.calls.push({method: 'beginVoice', config: request});
        return {sessionID: page.label + '-session'};
      },
      finishVoice: request => runReply('finishVoice', request),
      continuousSnapshot: token => {
        page.snapshots.push(token);
        return page.activeToken === token ? {token, state: page.finished ? 'finished' : 'playing', position: 0.25,
          bufferedSeconds: 0.5, sampleRate: 24000, playedSamples: 6000} : null;
      },
      continuousControl: (token, control) => {
        assert.equal(page.closed, false, 'a retired page must never receive late playback control');
        assert.equal(token, page.activeToken, 'control must belong to the current renderer');
        page.controls.push({token, control});
        return true;
      },
      close: async () => { page.activeToken = null; },
    }};
    pages.push(page); return page;
  }, dispose: page => host.disposePage(page)});
  t.after(async () => {
    try {
      for (const page of pages) page.finish();
      for (const pending of gates) pending.resolve();
      await flush();
      await host.close();
      await Promise.allSettled(pendingTurns);
    } finally { clearInterval(watchdog); }
  });
  return {host, pages, gate, track};
}

test('continuous reply uses the exact host token and stays leased until playback drains', {timeout: 4000}, async t => {
  const {host, pages, track} = fixture(t), token = 'reply-one';
  const frames = [];
  let resolved = false;
  const pending = track(host.reply({...config, liveSpeechToken: 'untrusted-caller-token'}, {liveSpeech: {
    token, onFrame: async snapshot => { frames.push(snapshot); return playbackControl; },
  }}).then(value => { resolved = true; return value; }));
  await until(() => pages[0]?.controls.length, 'continuous reply never delivered playback control');
  const page = pages[0], submitted = page.calls.find(call => call.method === 'reply').config;
  assert.equal(submitted.liveSpeechToken, token);
  assert.equal(frames[0].token, token);
  assert.equal(page.snapshots.every(value => value === token), true);
  assert.deepEqual(page.controls[0], {token, control: playbackControl});
  assert.equal(resolved, false, 'provider submission is not playback completion');
  assert.equal([...host.pool.entries.values()][0].busy, true);
  page.finish();
  assert.equal((await pending).sessionID, page.label + '-session');
  assert.equal(page.closed, false, 'a successful private turn retains its connection');
  assert.equal([...host.pool.entries.values()][0].busy, false);
  const calls = page.controls.length;
  await sleep(90);
  assert.equal(page.controls.length, calls, 'the control pump stops at playback completion');
});

test('slow frame callbacks are serialized and cannot accumulate control writes', {timeout: 4000}, async t => {
  const {host, pages, gate, track} = fixture(t), blocked = gate();
  let active = 0, maximum = 0, calls = 0;
  const pending = track(host.reply(config, {liveSpeech: {token: 'serialized-turn', onFrame: async () => {
    active++; maximum = Math.max(maximum, active); calls++;
    try { if (calls === 1) await blocked.promise; return playbackControl; }
    finally { active--; }
  }}}));
  await until(() => calls === 1, 'continuous reply never requested its first frame');
  await sleep(130);
  assert.equal(calls, 1, 'another timer tick must not overlap a pending frame callback');
  assert.equal(maximum, 1);
  assert.equal(pages[0].controls.length, 0, 'control awaits the callback decision');
  blocked.resolve();
  await until(() => calls >= 2 && pages[0].controls.length >= 2, 'serialized pump did not resume');
  assert.equal(maximum, 1);
  pages[0].finish(); await pending;
});

test('a frame callback failure rejects the reply and discards its audio page', {timeout: 4000}, async t => {
  const {host, pages, track} = fixture(t);
  const pending = track(host.reply(config, {liveSpeech: {token: 'callback-failure',
    onFrame: async () => { throw Error('Game playback lease is unavailable'); },
  }}));
  await assert.rejects(pending, /Game playback lease is unavailable/);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].closed, true);
  assert.equal(pages[0].controls.length, 0);
  assert.equal(host.pool.entries.size, 0);
  assert.equal(host.sessions.owners.size, 0, 'failed playback must not admit a returned session');
});

test('the final drain snapshot waits for the pending callback and never reopens completed playback', {timeout: 4000}, async t => {
  const {host, pages, gate, track} = fixture(t), blocked = gate();
  const states = [];
  let active = 0, maximum = 0, resolved = false;
  const pending = track(host.reply(config, {liveSpeech: {token: 'drain-during-frame', onFrame: async frame => {
    active++; maximum = Math.max(maximum, active); states.push(frame.state);
    try { if (states.length === 1) await blocked.promise; return playbackControl; }
    finally { active--; }
  }}}).then(value => { resolved = true; return value; }));
  await until(() => states.length === 1, 'first frame callback never started');
  pages[0].finish();
  await sleep(60);
  assert.equal(resolved, false, 'drain acknowledgement must wait for the previous callback');
  assert.deepEqual(states, ['playing']);
  blocked.resolve(); await pending;
  assert.deepEqual(states, ['playing', 'finished']);
  assert.equal(maximum, 1);
  assert.equal(pages[0].controls.length, 0, 'neither a late frame decision nor the final snapshot can restart drained playback');
});

test('aborting a pending frame callback fences its late control from a replacement turn', {timeout: 4000}, async t => {
  const {host, pages, gate, track} = fixture(t), blocked = gate(), entered = gate();
  const controller = new AbortController();
  const old = track(host.reply(config, {signal: controller.signal, liveSpeech: {
    token: 'obsolete-turn', onFrame: async () => { entered.resolve(); await blocked.promise; return playbackControl; },
  }}));
  await entered.promise;
  controller.abort();
  await assert.rejects(old, {name: 'AbortError'});
  assert.equal(pages[0].closed, true);

  const replacement = track(host.reply(config, {liveSpeech: {token: 'replacement-turn',
    onFrame: async () => ({...playbackControl, volume: 0.4}),
  }}));
  await until(() => pages[1]?.controls.length, 'replacement turn never received its own control');
  blocked.resolve();
  await sleep(90);
  assert.equal(pages[0].controls.length, 0, 'late decisions cannot touch a discarded page');
  assert.equal(pages[1].controls.every(call => call.token === 'replacement-turn' && call.control.volume === 0.4), true);
  pages[0].finish(); pages[1].finish();
  await replacement;
  assert.equal(host.sessions.owners.has('page-0-session'), false);
});

test('text-only replies bypass continuous playback even if options and a stale token are supplied', {timeout: 4000}, async t => {
  const {host, pages, track} = fixture(t);
  let frames = 0;
  const pending = track(host.reply({...config, ttsEnabled: false, liveSpeechToken: 'stale'}, {liveSpeech: {
    token: 'must-not-play', onFrame: async () => { frames++; return playbackControl; },
  }}));
  await until(() => pages[0]?.calls.some(call => call.method === 'reply'), 'text reply never reached its page');
  await sleep(90);
  const page = pages[0];
  assert.equal(page.calls.find(call => call.method === 'reply').config.liveSpeechToken, undefined);
  assert.equal(frames, 0);
  assert.equal(page.snapshots.length, 0);
  assert.equal(page.controls.length, 0);
  page.finish(); await pending;
});

test('voice-channel finish forwards the continuous token and controls until playback drains', {timeout: 4000}, async t => {
  const {host, pages, track} = fixture(t), channel = host.voiceChannel();
  await channel.beginVoice(config);
  let resolved = false;
  const pending = track(channel.finishVoice(config, {liveSpeech: {token: 'voice-turn',
    onFrame: async () => playbackControl,
  }}).then(value => { resolved = true; return value; }));
  await until(() => pages[0]?.controls.length, 'voice completion did not forward live playback options');
  const page = pages[0];
  assert.equal(page.calls.find(call => call.method === 'finishVoice').config.liveSpeechToken, 'voice-turn');
  assert.equal(page.controls[0].token, 'voice-turn');
  assert.equal(resolved, false);
  assert.equal(host.voiceLease?.value, page);
  page.finish(); await pending;
  assert.equal(host.voiceLease, null);
  assert.equal(page.closed, false);
  assert.equal(page.permissions.filter(call => call[0] === 'clear').length, 1);
});

test('closing a voice channel aborts its pending playback callback and retires the microphone lease', {timeout: 4000}, async t => {
  const {host, pages, gate, track} = fixture(t), channel = host.voiceChannel(), blocked = gate();
  let entered = false;
  await channel.beginVoice(config);
  const pending = track(channel.finishVoice(config, {liveSpeech: {token: 'cancelled-voice', onFrame: async () => {
    entered = true; await blocked.promise; return playbackControl;
  }}}));
  await until(() => entered, 'voice frame callback never started');
  await channel.close();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(host.voiceLease, null);
  assert.equal(pages[0].closed, true);
  blocked.resolve(); await sleep(60);
  assert.equal(pages[0].controls.length, 0);
  assert.equal(host.pool.entries.size, 0);
});
