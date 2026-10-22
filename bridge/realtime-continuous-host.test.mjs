import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {RealtimeHost, continuousSnapshotForHost, CONTINUOUS_SNAPSHOT_JSON_LIMIT} from './realtime-host.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
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
async function until(predicate, message, timeout = 60000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await sleep(5);
  }
}
const playbackControl = {allow: true, paused: false, volume: 0.75, pan: -0.2};

test('snapshot transport returns one JSON string and preserves the public numeric object exactly', async () => {
  const snapshot={version:1,token:'offline',positionSeconds:.12345678912345678,
    faces:[{at:1/60,values:Array.from({length:61},(_,index)=>index/100)}],
    state:'playing',ended:false,text:'Offline test',error:null};
  let serialized;
  const requests=[];
  const page={evaluate:async(fn,payload)=>{
    assert.equal(payload.token,'offline');
    serialized=runInNewContext(`(${fn.toString()})(payload)`,{
      window:{convaiRealtime:{continuousSnapshot:(token,pcmFrom)=>{requests.push([token,pcmFrom]);return snapshot;}}},payload});
    assert.equal(typeof serialized,'string','large facial values must bypass the recursive object serializer');
    return serialized;
  }};
  assert.deepEqual(await continuousSnapshotForHost(page,'offline'),snapshot);
  // The facial model's analysis cursor is forwarded only as a safe integer.
  await continuousSnapshotForHost(page,'offline',undefined,4800);
  await continuousSnapshotForHost(page,'offline',undefined,-1);
  await continuousSnapshotForHost(page,'offline',undefined,1.5);
  assert.deepEqual(requests,[['offline',undefined],['offline',4800],['offline',undefined],['offline',undefined]]);
});

test('absent continuous snapshots remain absent through JSON transport',async()=>{
  for(const raw of [undefined,null,'null'])
    assert.equal(await continuousSnapshotForHost({evaluate:async()=>raw},'offline'),null);
});

test('corrupted, oversized and non-object snapshot responses fail without exposing their contents',async()=>{
  for(const raw of ['{"private":"not diagnostic data"',123,{},'123','[]',
    'x'.repeat(CONTINUOUS_SNAPSHOT_JSON_LIMIT+1)]){
    await assert.rejects(continuousSnapshotForHost({evaluate:async()=>raw},'offline'),error=>{
      assert.match(error.message,/Invalid continuous browser snapshot/);
      assert(!error.message.includes('private')&&!error.message.includes('diagnostic data'));
      return true;
    });
  }
});

test('JSON decoding cannot bypass downstream finite device-clock validation',async()=>{
  const input={requestId:'offline',entity:'offline',generation:1};
  let writes=0;
  const producer=new ConvaiContinuousSpeech({input,profile:{key:'offline'},token:'offline',current:async()=>true,
    readControl:async()=>'',writeState:async()=>{writes++;return true;},writeReply:async()=>true});
  const value={version:1,token:'offline',sampleRate:24000,channels:1,receivedFrames:12000,
    positionSeconds:NaN,text:'Offline',textComplete:false,sourceComplete:false,ended:false,underruns:0,state:'playing'};
  const decoded=await continuousSnapshotForHost({evaluate:async()=>JSON.stringify(value)},'offline');
  assert.equal(decoded.positionSeconds,null);
  await assert.rejects(producer.frame(decoded),/Invalid continuous speech state/);
  assert.equal(writes,0);
});

test('snapshot size ceiling counts UTF-8 bytes rather than only string characters',async()=>{
  const raw=JSON.stringify('中'.repeat(Math.floor(CONTINUOUS_SNAPSHOT_JSON_LIMIT/3)+1));
  assert(raw.length<CONTINUOUS_SNAPSHOT_JSON_LIMIT);
  await assert.rejects(continuousSnapshotForHost({evaluate:async()=>raw},'offline'),
    /Invalid continuous browser snapshot size/);
});

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

test('continuous reply uses the exact host token and stays leased until playback drains', {timeout: 120000}, async t => {
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

test('a foreign decoded snapshot never reaches the frame callback or playback control', {timeout: 120000},async t=>{
  const {host,pages,track}=fixture(t);
  let callbacks=0;
  const pending=track(host.reply(config,{liveSpeech:{token:'owned',onFrame:async()=>{
    callbacks++;return playbackControl;
  }}}));
  await until(()=>pages[0]?.activeToken,'reply did not begin');
  const page=pages[0];
  page.window.convaiRealtime.continuousSnapshot=()=>({token:'foreign',state:'playing',position:.2});
  await sleep(100);page.finish();await pending;
  assert.equal(callbacks,0);assert.equal(page.controls.length,0);
});

test('slow frame callbacks are serialized and cannot accumulate control writes', {timeout: 120000}, async t => {
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

test('a frame callback failure rejects the reply and discards its audio page', {timeout: 120000}, async t => {
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

test('the final drain snapshot waits for the pending callback and never reopens completed playback', {timeout: 120000}, async t => {
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

test('aborting a pending frame callback fences its late control from a replacement turn', {timeout: 120000}, async t => {
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

test('text-only replies bypass continuous playback even if options and a stale token are supplied', {timeout: 120000}, async t => {
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

test('voice-channel finish forwards the continuous token and controls until playback drains', {timeout: 120000}, async t => {
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

test('closing a voice channel aborts its pending playback callback and retires the microphone lease', {timeout: 120000}, async t => {
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

// 2026-10-22 review (R3): a turn whose packets are mislabelled (24 kHz on 44.1 kHz audio) is already playing at the label when the final statistics correct the rate; the corrected
// rate in the snapshot then read as a changed format and the live speech threw "Continuous speech format changed". The player's own rate keeps being reported to it.
test('a rate corrected at the end of a live turn is remembered for the character but the frame keeps the rate the player runs at', {timeout: 120000}, async t => {
  const {host, pages, track} = fixture(t), token = 'mislabelled', frames = [];
  const pending = track(host.reply(config, {liveSpeech: {token, onFrame: async snapshot => { frames.push(snapshot); return playbackControl; }}}));
  await until(() => pages[0]?.controls.length, 'continuous reply never delivered playback control');
  const page = pages[0];
  page.window.convaiRealtime.continuousSnapshot = requested => requested === page.activeToken ? {token: requested, state: 'playing', positionSeconds: .25, sampleRate: 44100, openedSampleRate: 24000,
    sampleRateCorrected: {declared: 24000, actual: 44100}} : null;
  const before = frames.length;
  await until(() => frames.length > before + 1, 'frames of the corrected turn');
  assert.equal(frames.at(-1).sampleRate, 24000, 'the live speech sees the rate the player runs at');
  assert.equal(Object.hasOwn(frames.at(-1), 'openedSampleRate'), false); assert.deepEqual(frames.at(-1).sampleRateCorrected, {declared: 24000, actual: 44100});
  page.finish(); await pending;
  assert.deepEqual(host.audioRates.hintFor(config.characterId), {declared: 24000, actual: 44100}, 'the character learned the rate for its next turn');
});

test('a snapshot that reports one rate is passed through untouched (no copy per poll)', {timeout: 120000}, async t => {
  const {host, pages, track} = fixture(t), frames = [];
  const pending = track(host.reply(config, {liveSpeech: {token: 'plain', onFrame: async snapshot => { frames.push(snapshot); return playbackControl; }}}));
  await until(() => frames.length > 2, 'frames');
  assert.ok(frames.every(frame => frame.sampleRate === 24000));
  pages[0].finish(); await pending;
});
