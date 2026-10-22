import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {LocalPcmClient} from './local-pcm-client.mjs';
import {LocalPcmHost, ownedLocalPcmPacket, ownedFaceCopy, localSnapshotForHost} from './local-pcm-host.mjs';
import {encodePcmWav} from './convai-audio-stream.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
// The ceiling is reached only by a hung test; on a busy machine a slow step must never become a failure.
async function until(predicate) {
  const deadline = performance.now() + 60_000;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail('Offline PCM test did not reach its owned gate');
    await sleep(5);
  }
}
const control = {allow: true, paused: false, volume: .8, pan: .2};
const packet = (extra = {}) => ({version: 1, engine: 'pocket-tts', sampleRate: 24000, channels: 1,
  format: 'f32le', owner: '1'.repeat(32), id: 1, profile: 'judy', modelSha256: '2'.repeat(64),
  index: 1, offsetFrames: 0, frames: 9600, pcm: new Float32Array(9600), ...extra});

class OfflinePlayer {
  constructor({manualAck = false} = {}) {
    this.manualAck = manualAck; this.frames = 0; this.controls = []; this.copies = [];
    this.state = 'awaiting-admission'; this.ended = false; this.error = null; this.pending = null;
  }
  async open(value) { this.token = value.token; this.format = value; }
  append(bytes, offset) {
    assert.equal(offset, this.frames); this.copies.push(bytes.slice());
    this.pending = deferred();
    if (!this.manualAck) this.pending.resolve();
    return this.pending.promise.then(() => { this.frames += bytes.length / 2; });
  }
  snapshot() { return {state: this.state, sampleRate: 24000, channels: 1, receivedFrames: this.frames,
    playedFrames: this.ended ? this.frames : 0, positionSeconds: this.ended ? this.frames / 24000 : 0,
    bufferedFrames: this.ended ? 0 : this.frames, ended: this.ended, error: this.error, underruns: 0}; }
  control(value) {
    if (this.stopped) throw Error('PCM player is not open');
    this.controls.push({...value}); this.state = 'playing';
  }
  async end(frames) { assert.equal(frames, this.frames); this.sealed = true; }
  finish() { assert(this.sealed); this.ended = true; this.state = 'ended'; this.stopped = true; }
  fail(message) { this.error = message; this.state = 'error'; }
  async stop() { this.stopped = true; this.pending?.reject(Error('Offline renderer retired')); }
}

function fixture(t, {manualAck = false, timeoutMs = 120_000} = {}) {
  const pages = [], players = [], tasks = [];
  const host = new LocalPcmHost({pollMs: 5, timeoutMs, cleanupTimeoutMs: 30_000,
    createPage: async () => {
      const client = new LocalPcmClient({createPlayer: () => {
        const player = new OfflinePlayer({manualAck}); players.push(player); return player;
      }});
      const page = {closed: false, calls: [], window: {localPcm: client},
        isClosed() { return this.closed; },
        async close() { this.closed = true; if (client.active) await client.stop(client.active.token); },
        async evaluate(fn, payload) {
          if (this.closed) throw Error('Offline page is closed');
          this.calls.push({source: fn.toString(), payload});
          return runInNewContext(`(${fn.toString()})(payload)`, {window: this.window, payload});
        },
      };
      pages.push(page); return page;
    }});
  const track = value => { tasks.push(value); value.catch(() => {}); return value; };
  t.after(async () => { await host.close(); await Promise.allSettled(tasks); });
  return {host, pages, players, track};
}

test('local PCM owns a source copy and matches the established device conversion exactly', () => {
  const samples = new Float32Array([-2, -1, -.3, 0, .3, 1, 2]);
  const input = packet({pcm: samples, frames: samples.length});
  const owned = ownedLocalPcmPacket(input, {token: 'owned', frames: 0, index: 0});
  const expected = Buffer.from(encodePcmWav(samples, 24000), 'base64').subarray(44);
  samples.fill(.9); input.owner = '3'.repeat(32); input.index = 99;
  assert.deepEqual(Buffer.from(owned.packet.pcm, 'base64'), expected);
  assert.equal(owned.packet.owner, '1'.repeat(32)); assert.equal(owned.packet.index, 1);
  assert.equal(owned.packet.format, 's16le');
  for (const extra of [{pcm: new Float32Array([NaN]), frames: 1}, {channels: 2}, {sampleRate: 48000},
    {index: 2}, {offsetFrames: 1}, {frames: 9599}, {owner: 'wrong'}, {modelSha256: 'wrong'},
    {id: 0}, {format: 's16le'}, {pcm: new Int16Array(9600)}])
    assert.throws(() => ownedLocalPcmPacket(packet(extra), {token: 'owned', frames: 0, index: 0}), /Local PCM/);
});

test('the worker ACK follows the renderer copy, and completion waits for device drain', {timeout: 120_000}, async t => {
  const {host, pages, players, track} = fixture(t, {manualAck: true});
  const seen = [], emotion = {type: 'happy', requestId: 'original'};
  const config = {token: 'copy-and-drain', text: 'One whole reply. Another sentence.',
    expressionSignal: emotion, userText: 'Can you help?'};
  let producerCalls = 0, acked = false, generated = false, resolved = false;
  const pending = track(host.play(config, async emit => {
    producerCalls++;
    const input = packet({pcm: new Float32Array(9600).fill(.25)});
    const ack = emit(input);
    input.pcm.fill(NaN); input.index = 12;
    await ack; acked = true; generated = true;
    return {timing: {voiceGenerationMs: 20}};
  }, {onFrame: frame => { seen.push(frame); return control; }}).then(value => { resolved = true; return value; }));
  await until(() => players[0]?.copies.length);
  emotion.type = 'changed'; config.text = 'changed';
  assert.equal(acked, false, 'receipt must wait for the worklet ring copy');
  assert.equal(new DataView(players[0].copies[0].buffer).getInt16(0, true), 8192);
  players[0].pending.resolve();
  await until(() => players[0]?.sealed);
  assert.equal(generated, true); assert.equal(resolved, false, 'model completion is not audible drain');
  await until(() => seen.some(value => value.sourceComplete));
  assert.equal(seen.every(value => value.text === 'One whole reply. Another sentence.'), true);
  assert.equal(seen.every(value => value.textComplete), true);
  assert.equal(seen[0].expressionSignal.type, 'happy');
  players[0].finish(); const result = await pending;
  assert.equal(producerCalls, 1); assert.equal(result.streamed, true); assert.equal(result.frames, 9600);
  assert.equal(result.snapshot.positionSeconds, .4); assert.equal(result.snapshot.ended, true);
  assert.equal(players[0].stopped, true); assert.equal(pages[0].closed, false, 'successful page can be reused');
  assert.equal(result.timing.voiceGenerationMs, 20);
});

test('synthesis starts while the renderer opens, and its packets wait for that renderer', {timeout: 120_000}, async t => {
  const gate = deferred(), players = [];
  const host = new LocalPcmHost({pollMs: 5, timeoutMs: 120_000, cleanupTimeoutMs: 30_000, createPage: async () => {
    await gate.promise;
    const client = new LocalPcmClient({createPlayer: () => { const player = new OfflinePlayer(); players.push(player); return player; }});
    return {closed: false, window: {localPcm: client}, isClosed() { return this.closed; },
      async close() { this.closed = true; if (client.active) await client.stop(client.active.token); },
      async evaluate(fn, payload) { return runInNewContext(`(${fn.toString()})(payload)`, {window: this.window, payload}); }};
  }});
  t.after(() => host.close());
  let producerStarted = false, emitted = false;
  const pending = host.play({token: 'overlapped-start', text: 'Whole reply'}, async emit => {
    producerStarted = true;
    await emit(packet()); emitted = true;
  }, {onFrame: () => control});
  pending.catch(() => {});
  await until(() => producerStarted);
  await sleep(20);
  assert.equal(players.length, 0, 'the renderer is still opening');
  assert.equal(emitted, false, 'the first packet must wait for the opened renderer');
  gate.resolve();
  await until(() => players[0]?.sealed);
  assert.equal(players[0].copies.length, 1); assert.equal(emitted, true);
  players[0].finish();
  const result = await pending;
  assert.equal(result.frames, 9600); assert.equal(result.snapshot.ended, true);
  assert.equal(typeof result.timing.localPcmRendererReadyMs, 'number');
});

test('a drained page can render a fresh utterance without carrying its previous owner or text', {timeout: 120_000}, async t => {
  const {host, pages, players, track} = fixture(t);
  for (const [playerIndex, token] of ['first', 'second'].entries()) {
    const frames = [];
    const pending = track(host.play({token, text: token}, emit => emit(packet()), {
      onFrame: frame => { frames.push(frame); return control; }}));
    await until(() => players[playerIndex]?.sealed);
    players[playerIndex].finish(); await pending;
    assert.equal(frames.every(frame => frame.token === token && frame.text === token), true);
  }
  assert.equal(pages.length, 1); assert.equal(players.length, 2);
});

test('device drain during an awaited game callback cannot submit a control to the closed player', {timeout: 120_000}, async t => {
  const {host, pages, players, track} = fixture(t), held = deferred(), release = deferred();
  const seen = [];
  let controlsAtDrain;
  const pending = track(host.play({token: 'drain-during-admission', text: 'Whole reply'}, emit => emit(packet()), {
    onFrame: async snapshot => {
      seen.push(snapshot);
      if (snapshot.sourceComplete && !snapshot.ended) { held.resolve(); await release.promise; }
      return control;
    },
  }));
  await held.promise; controlsAtDrain = players[0].controls.length;
  // The actual player timer does this independently of the host's await.
  players[0].finish(); release.resolve();
  const result = await pending;
  assert.equal(result.snapshot.ended, true); assert.equal(result.snapshot.positionSeconds, .4);
  assert.equal(seen.at(-1).ended, true, 'the final device snapshot must still reach game/face publication');
  assert.equal(seen.filter(value => value.ended).length, 1);
  assert.equal(players[0].controls.length, controlsAtDrain, 'late admission must never reopen drained PCM');
  assert.equal(pages[0].closed, false, 'a normal audible drain must not discard the local page as a failure');
});

test('late-control drain handling cannot ignore an explicit stop, a foreign token or a renderer error', async () => {
  const player = new OfflinePlayer(), client = new LocalPcmClient({createPlayer: () => player});
  await client.begin({token: 'strict-owner', text: 'Owned'});
  assert.throws(() => client.control('foreign-owner', control), /Local PCM owner changed/);
  player.fail('Renderer lease expired');
  assert.throws(() => client.control('strict-owner', control), /Local PCM renderer failed/);
  assert.equal(player.controls.length, 0);
  await client.stop('strict-owner');
  assert.throws(() => client.control('strict-owner', control), /Local PCM owner changed/);
});

test('native face prefixes are copied from the exact turn hook while audio continues', {timeout: 120_000}, async t => {
  const {host, players, track} = fixture(t);
  const face = {version: 1, requestId: 'face-owned', entity: 'judy', generation: 1,
    frames: [[0, .25]], duration: .4, complete: false};
  const seen = [];
  const pending = track(host.play({token: 'face-owned', text: 'Whole reply'}, emit => emit(packet()), {
    getFace: () => face, onFrame: snapshot => { seen.push(snapshot); return control; }}));
  await until(() => players[0]?.sealed && seen.some(frame => frame.face));
  const saved = seen.find(frame => frame.face);
  face.frames[0][1] = .5; face.complete = true;
  assert.equal(saved.face.frames[0][1], .25); assert.equal(saved.face.complete, false);
  players[0].finish(); await pending;
  assert.equal(seen.at(-1).face.frames[0][1], .5);
});

test('facial prefixes follow acknowledged renderer frames while the producer has future PCM', {timeout: 120_000}, async t => {
  const {host, players, track} = fixture(t, {manualAck: true});
  const seen = [], facialCalls = [];
  let producedFrames = 0, producerComplete = false;
  const pending = track(host.play({token: 'facial-ack-boundary', text: 'Whole reply'}, async emit => {
    producedFrames = 9600;
    await emit(packet());
    producedFrames = 19200;
    await emit(packet({index: 2, offsetFrames: 9600}));
    producerComplete = true;
  }, {
    getFace: snapshot => {
      assert.equal(snapshot.token, 'facial-ack-boundary');
      assert(snapshot.receivedFrames <= producedFrames);
      assert.equal(snapshot.sourceComplete && !producerComplete, false);
      facialCalls.push({receivedFrames: snapshot.receivedFrames, sourceComplete: snapshot.sourceComplete,
        producedFrames, producerComplete});
      return {version: 1, requestId: 'facial-ack-boundary', duration: snapshot.receivedFrames / 24000,
        complete: snapshot.sourceComplete, frames: [[0, .25]]};
    },
    onFrame: snapshot => { seen.push(snapshot); return control; },
  }));
  await until(() => players[0]?.copies.length === 1);
  await until(() => facialCalls.some(value => value.producedFrames === 9600 && value.receivedFrames === 0));
  players[0].pending.resolve();
  await until(() => players[0]?.copies.length === 2);
  await until(() => facialCalls.some(value => value.producedFrames === 19200 && value.receivedFrames === 9600));
  assert.equal(producerComplete, false);
  players[0].pending.resolve();
  await until(() => players[0]?.sealed && seen.some(value => value.sourceComplete));
  players[0].finish(); await pending;
  assert.equal(seen.every(value => value.face.duration === value.receivedFrames / 24000
    && value.face.complete === value.sourceComplete), true);
  assert.equal(seen.at(-1).receivedFrames, 19200); assert.equal(seen.at(-1).face.complete, true);
});

test('producer identity and contiguous offsets cannot change after the first owned copy', {timeout: 120_000}, async t => {
  const {host, pages, track} = fixture(t);
  const pending = track(host.play({token: 'wrong-producer', text: 'Owned'}, async emit => {
    await emit(packet());
    await emit(packet({index: 2, offsetFrames: 9600, id: 2}));
  }, {onFrame: () => control}));
  await assert.rejects(pending, /Local PCM producer changed/);
  assert.equal(pages[0].closed, true); assert.equal(host.active, null); assert.equal(host.page, null);
});

test('abort cancels a thinking producer and discards its renderer before any late control', {timeout: 120_000}, async t => {
  const {host, pages, players, track} = fixture(t);
  const controller = new AbortController(), blocked = deferred(), entered = deferred();
  let producerAborted = false, callbacks = 0;
  const pending = track(host.play({token: 'aborted', text: 'Owned'}, async (emit, {signal}) => {
    await new Promise(resolve => {
      signal.addEventListener('abort', () => { producerAborted = true; resolve(); }, {once: true});
    });
  }, {signal: controller.signal, onFrame: async () => {
    callbacks++; entered.resolve(); await blocked.promise; return control;
  }}));
  await entered.promise; await until(() => pages[0]);
  controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(producerAborted, true); assert.equal(pages[0].closed, true);
  blocked.resolve(); await sleep(30);
  assert.equal(callbacks, 1); assert.equal(players[0].controls.length, 0);
});

test('a changed game owner fences late admission and cancels synthesis', {timeout: 120_000}, async t => {
  const {host, pages, players, track} = fixture(t), blocked = deferred(), entered = deferred();
  let current = true, aborted = false;
  const pending = track(host.play({token: 'stale', text: 'Owned'}, async (emit, {signal}) => {
    signal.addEventListener('abort', () => { aborted = true; }, {once: true});
    await emit(packet());
    await new Promise(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, {once: true});
    });
  }, {current: () => current, onFrame: async () => { entered.resolve(); await blocked.promise; return control; }}));
  await entered.promise; current = false; blocked.resolve();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(pages[0].closed, true); assert.equal(players[0].controls.length, 0);
  await until(() => aborted);
});

test('a failed game callback aborts the between-yields producer and discards its page', {timeout: 120_000}, async t => {
  const {host, pages, track} = fixture(t), producing = deferred();
  let aborted = false;
  const pending = track(host.play({token: 'failed-callback', text: 'Owned'}, async (emit, {signal}) => {
    signal.addEventListener('abort', () => { aborted = true; }, {once: true}); producing.resolve();
    await new Promise(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, {once: true});
    });
  }, {onFrame: async () => { await producing.promise; throw Error('Game admission unavailable'); }}));
  await assert.rejects(pending, /Game admission unavailable/);
  assert.equal(aborted, true); assert.equal(pages[0].closed, true);
});

test('overlapping local turns and foreign renderer receipts cannot be admitted', {timeout: 120_000}, async t => {
  const {host, pages, track} = fixture(t), gate = deferred();
  const pending = track(host.play({token: 'owned', text: 'Owned'}, async emit => {
    await gate.promise; return emit(packet());
  }, {onFrame: () => control}));
  await until(() => pages[0]);
  await assert.rejects(host.play({token: 'other', text: 'Other'}, () => {}, {onFrame: () => control}), /already owned/);
  const append = pages[0].window.localPcm.append.bind(pages[0].window.localPcm);
  pages[0].window.localPcm.append = async value => ({...await append(value), token: 'foreign'});
  gate.resolve();
  await assert.rejects(pending, /did not acknowledge the owned copy/);
  assert.equal(pages[0].closed, true);
});

test('failed or foreign snapshots reject without forwarding private data', async () => {
  for (const raw of [undefined, null, '[]', 'invalid', JSON.stringify({version: 1, token: 'foreign'}),
    JSON.stringify({version: 1, token: 'owned', sampleRate: 24000, channels: 1, engine: 'pocket-tts',
      voiceProvider: 'pocket', receivedFrames: 10, positionSeconds: 1, sourceComplete: false, ended: false})])
    await assert.rejects(localSnapshotForHost({evaluate: async () => raw}, 'owned'), /Invalid local PCM snapshot/);
});

test('a cancelled factory cannot donate its late page to a new turn', {timeout: 120_000}, async () => {
  const creating = deferred(), controller = new AbortController(), factoryCalled = deferred();
  let closes = 0;
  // The factory limit is not what this test is about, so it is long: only the abort may end the wait for the page.
  const host = new LocalPcmHost({createPage: () => { factoryCalled.resolve(); return creating.promise; }, commandTimeoutMs: 60_000});
  const pending = host.play({token: 'cancelled-factory', text: 'Owned'}, () => {},
    {signal: controller.signal, onFrame: () => control});
  pending.catch(() => {});
  await factoryCalled.promise; controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  creating.resolve({isClosed: () => false, close: async () => { closes++; }});
  await until(() => closes === 1); assert.equal(host.page, null); assert.equal(host.active, null);
  await host.close();
});

test('renderer retirement uses only its own context when page close fails', async () => {
  let pageCloses = 0, contextCloses = 0;
  const host = new LocalPcmHost({createPage: async () => assert.fail('No page admission is needed')});
  const page = {isClosed: () => false, close: async () => { pageCloses++; throw Error('Page close failed'); },
    context: () => ({close: async () => { contextCloses++; }})};
  await Promise.all([host.dispose(page), host.dispose(page)]);
  assert.equal(pageCloses, 1); assert.equal(contextCloses, 1); assert.equal(host.failure, undefined);
  await host.close();
});

test('unconfirmed renderer retirement fences every later local admission', async () => {
  const host = new LocalPcmHost({createPage: async () => assert.fail('Failed renderer must never be reused')});
  await assert.rejects(host.dispose({isClosed: () => false, close: async () => { throw Error('Owned close failed'); }}),
    /Owned close failed/);
  await assert.rejects(host.play({token: 'new', text: 'New'}, () => {}, {onFrame: () => control}), /Owned close failed/);
  await host.close();
});

test('RealtimeHost owns the separate local lane and cancels it during an epoch close', async () => {
  const entered = deferred(), host = new RealtimeHost();
  host.start = async () => {};
  let callbackCurrent, closed = 0;
  host.localPcm = {
    async play(config, producer, options) { callbackCurrent = options.current; entered.resolve(); return 'local'; },
    async close() { closed++; },
  };
  const before = host.sessions.owners.size;
  assert.equal(await host.playLocalPcm({token: 'owned', text: 'Owned'}, () => {}, {onFrame: () => control}), 'local');
  await entered.promise; assert.equal(await callbackCurrent(), true);
  await host.close(); assert.equal(await callbackCurrent(), false); assert.equal(closed, 1);
  assert.equal(host.sessions.owners.size, before, 'local PCM does not bind Convai memory sessions');
});

test('live text: each clock snapshot carries the reply text as written so far and whether it is final', {timeout: 120_000}, async t => {
  const {host, players, track} = fixture(t);
  const live = {text: 'Hey V, good to see you here again.', complete: false}, seen = [];
  const gate = deferred();
  const pending = track(host.play({token: 'live-text', text: live.text}, async emit => {
    await emit(packet());
    await gate.promise;
    live.text = 'Hey V, good to see you here again. What can I do for you?'; live.complete = true;
    await emit(packet({index: 2, offsetFrames: 9600}));
    return {};
  }, {liveText: () => ({...live}), onFrame: frame => { seen.push({text: frame.text, complete: frame.textComplete}); return control; }}));
  await until(() => seen.length >= 2);
  assert.deepEqual(seen[0], {text: 'Hey V, good to see you here again.', complete: false});
  gate.resolve();
  await until(() => players[0]?.sealed);
  players[0].finish();
  await pending;
  assert.deepEqual(seen.at(-1), {text: 'Hey V, good to see you here again. What can I do for you?', complete: true});
});

test('warm opens the renderer page ahead of the turn, and a turn that starts meanwhile uses that one page', {timeout: 120_000}, async t => {
  const {host, pages, players, track} = fixture(t);
  assert.equal(await host.warm(), true);
  assert.equal(pages.length, 1);
  assert.equal(await host.warm(), true, 'a warm page is kept');
  assert.equal(pages.length, 1);
  const pending = track(host.play({token: 'after-warm', text: 'Hello there, V.'}, async emit => { await emit(packet()); return {}; },
    {onFrame: () => control}));
  await until(() => players[0]?.sealed);
  players[0].finish();
  await pending;
  assert.equal(pages.length, 1, 'the turn used the warmed page');
  assert.equal(await host.warm(), true);
  assert.equal(pages.length, 1);
});

test('RealtimeHost.prewarmLocal starts the browser and warms the local page, and never throws', async () => {
  const host = new RealtimeHost();
  const calls = [];
  host.start = async () => { calls.push('start'); };
  host.localPcm = {async warm() { calls.push('warm'); return true; }};
  assert.equal(await host.prewarmLocal(), true);
  assert.deepEqual(calls, ['start', 'warm']);
  host.start = async () => { throw Error('no browser installed'); };
  assert.equal(await host.prewarmLocal(), false);
  host.start = async () => {}; host.localPcm = null;
  assert.equal(await host.prewarmLocal(), false);
});

test('wake ends the wait between two clock polls early: the first lease is read at once, not after the poll sleep', {timeout: 120_000}, async t => {
  const {host, players, track} = fixture(t);
  // The poll sleep is longer than the 60 s ceiling of until(): only the wake can end it, so a lease applied at all, after the wake,
  // proves the sleep was cut short. No elapsed-time figure is compared (that would only measure how busy the machine is).
  host.pollMs = 300_000;
  const polls = [];
  let wakeWaiter = null, leased = false;
  const pending = track(host.play({token: 'wake-test', text: 'One reply.'}, async emit => { await emit(packet()); return {}; },
    {onFrame: frame => { polls.push(frame); return leased ? control : undefined; },
      wake: () => new Promise(done => { wakeWaiter = done; })}));
  // The first poll found no lease and the loop is now in its poll sleep (waiting for the wake).
  await until(() => players[0]?.sealed && polls.length >= 1 && wakeWaiter);
  const before = polls.length;
  await sleep(50);
  assert.equal(polls.length, before, 'the long sleep is not cut short by itself');
  assert.equal(players[0].controls.length, 0);
  leased = true;
  wakeWaiter();
  await until(() => players[0]?.controls.length > 0);
  players[0].finish();
  // The loop is back in its (now 300 s) sleep: wake it until it has seen the drain and the turn is over.
  let over = false;
  pending.then(() => { over = true; }, () => { over = true; });
  for (const deadline = performance.now() + 60_000; !over && performance.now() < deadline;) { wakeWaiter(); await sleep(5); }
  assert.equal(over, true, 'the turn ended after the drain');
  await pending;
});

test('an invalid wake option is refused with the other admission checks', async t => {
  const {host} = fixture(t);
  await assert.rejects(host.play({token: 'bad-wake', text: 'x'}, async () => ({}), {onFrame: () => undefined, wake: 'soon'}), /Invalid local PCM admission/);
});

test('the first accepted audio ends the poll sleep: the snapshot that publishes the reply is taken at once, not after the sleep', {timeout: 120000}, async t => {
  const {host, players, track} = fixture(t);
  host.pollMs = 20_000;   // so long that only the audio ending the sleep can explain a poll in the next seconds, however busy the machine is
  const polls = [];
  const audio = deferred();
  let acceptedAt = null;
  const pending = track(host.play({token: 'first-audio', text: 'One reply.'}, async emit => {
    await audio.promise;
    await emit(packet());
    acceptedAt = performance.now();
    return {};
  }, {onFrame: frame => { polls.push({at: performance.now(), frames: frame.receivedFrames}); return undefined; }}));
  await until(() => polls.length >= 1);
  await sleep(30);
  assert.equal(polls.length, 1, 'no audio yet: the long sleep holds');
  audio.resolve();
  await until(() => polls.some(poll => poll.frames > 0));
  const first = polls.find(poll => poll.frames > 0);
  assert.ok(first.at - acceptedAt < 10_000, `the audio was polled ${Math.round(first.at - acceptedAt)} ms after it was accepted, well inside the 20 s sleep`);
  await until(() => players[0]?.sealed);
  players[0].finish();
  await sleep(0);
  host.pollMs = 5;
  await pending;
});

// A player with the standby states of ContinuousPcmPlayer (open on standby, arm, stop), for the spare device opened ahead of a turn.
class StandbyPlayer extends OfflinePlayer {
  constructor(options = {}, {opening} = {}) { super(); this.options = options; this.opening = opening; this.opens = 0; this.arms = 0; }
  async open(value) {
    this.opens++; this.token = value.token; this.format = value; this.standby = value.standby === true;
    if (this.opening) await this.opening;
    if (this.failOpen) throw Error('no audio device');
    this.opened = true;
  }
  async arm() { if (!this.standby || this.stopped) throw Error('PCM player is not on standby'); this.arms++; this.standby = false; }
  async stop() { this.stopped = true; await super.stop(); }
}

test('a spare device opened ahead of the turn is armed by begin(): one device, no second open', async () => {
  const players = [];
  const client = new LocalPcmClient({createPlayer: options => { const player = new StandbyPlayer(options); players.push(player); return player; }});
  assert.equal(await client.standby(), true);
  assert.equal(players.length, 1);
  assert.equal(players[0].format.standby, true, 'opened silent, with no lease');
  assert.equal(players[0].options.standbyMs, 30000, 'an unused spare closes itself after 30 s');
  assert.equal(await client.standby(), true, 'a second call keeps the same spare');
  assert.equal(players.length, 1);
  const snapshot = await client.begin({token: 'turn-1', text: 'Hey V.'});
  assert.equal(snapshot.token, 'turn-1');
  assert.equal(players.length, 1, 'the turn used the spare');
  assert.equal(players[0].arms, 1);
  assert.equal(players[0].opens, 1);
  assert.equal(client.spare, null);
  assert.equal(await client.standby(), false, 'a turn that owns the renderer has its own device: nothing more is opened');
  assert.equal(players.length, 1);
  await client.stop('turn-1');
  assert.equal(players[0].stopped, true);
});

test('a spare that failed or expired is replaced by a device opened the ordinary way', async () => {
  const players = [];
  const client = new LocalPcmClient({createPlayer: options => { const player = new StandbyPlayer(options); players.push(player); return player; }});
  assert.equal(await client.standby(), true);
  players[0].stopped = true;   // the standby ceiling closed it
  await client.begin({token: 'turn-1', text: 'Hey V.'});
  assert.equal(players.length, 2);
  assert.notEqual(players[1].format.standby, true, 'the turn opened its own device');
  assert.equal(players[1].format.token, 'turn-1');
  await client.stop('turn-1');
  // A spare whose device could not open is dropped at once, and the turn opens one itself.
  const failing = [];
  const other = new LocalPcmClient({createPlayer: options => {
    const player = new StandbyPlayer(options); if (!failing.length) player.failOpen = true; failing.push(player); return player; }});
  assert.equal(await other.standby(), false);
  assert.equal(other.spare, null);
  await other.begin({token: 'turn-2', text: 'Hey V.'});
  assert.equal(failing.length, 2);
  assert.notEqual(failing[1].format.standby, true);
});

test('a turn that starts while its spare is still opening waits for that device instead of opening a second one', async () => {
  const players = [], gate = deferred();
  const client = new LocalPcmClient({createPlayer: options => {
    const player = new StandbyPlayer(options, {opening: players.length ? undefined : gate.promise}); players.push(player); return player; }});
  const standby = client.standby();
  const beginning = client.begin({token: 'turn-1', text: 'Hey V.'});
  await sleep(10);
  assert.equal(players.length, 1);
  gate.resolve();
  assert.equal(await standby, true);
  await beginning;
  assert.equal(players.length, 1, 'still one device');
  assert.equal(players[0].arms, 1);
  // Stopped while its spare was being armed: the turn is cancelled and the device closed.
  const late = deferred(), owned = [];
  const second = new LocalPcmClient({createPlayer: options => { const player = new StandbyPlayer(options, {opening: late.promise}); owned.push(player); return player; }});
  void second.standby();
  const starting = second.begin({token: 'turn-2', text: 'Hey V.'});
  await second.stop('turn-2');
  late.resolve();
  await assert.rejects(starting, /cancelled|not on standby/);
  assert.ok(owned.every(player => player.stopped), 'no device is left open');
  assert.equal(second.active, null);
});

test('LocalPcmHost.standby opens the page and a spare device; the next turn uses both, and standby never interrupts a turn', {timeout: 120000}, async t => {
  const pages = [], players = [];
  const host = new LocalPcmHost({pollMs: 5, timeoutMs: 120_000, cleanupTimeoutMs: 30_000, createPage: async () => {
    const client = new LocalPcmClient({createPlayer: options => { const player = new StandbyPlayer(options); players.push(player); return player; }});
    const page = {closed: false, window: {localPcm: client}, isClosed() { return this.closed; },
      async close() { this.closed = true; if (client.active) await client.stop(client.active.token); },
      async evaluate(fn, payload) {
        if (this.closed) throw Error('Offline page is closed');
        return runInNewContext(`(${fn.toString()})(payload)`, {window: this.window, payload});
      }};
    pages.push(page); return page;
  }});
  t.after(() => host.close());
  assert.equal(await host.standby(), true);
  assert.equal(pages.length, 1);
  assert.equal(players.length, 1);
  assert.equal(players[0].format.standby, true);
  const pending = host.play({token: 'standby-turn', text: 'One reply.'}, async emit => { await emit(packet()); return {}; },
    {onFrame: () => control});
  await until(() => players[0].sealed);
  assert.equal(await host.standby(), false, 'a turn owns the renderer');
  players[0].finish();
  await pending;
  assert.equal(pages.length, 1, 'the warmed page');
  assert.equal(players.length, 1, 'the spare device: none was opened during the turn');
  assert.equal(players[0].arms, 1);
  // A page that cannot be evaluated is reported as no spare, never thrown.
  pages[0].evaluate = async () => { throw Error('renderer gone'); };
  assert.equal(await host.standby(), false);
});

// 2026-10-22 review (W12): the page's 150 s limit was wall time for the whole reply, so a long reply on a slow computer was cut in the middle of a line while audio
// was still being produced. The limit is for standing still now: a packet accepted or the heard position advancing starts it over.
test('the page time limit is for standing still: a reply whose packets keep coming runs past it, and one that stops producing is cut', {timeout: 30_000}, async t => {
  const {host, players, track} = fixture(t, {timeoutMs: 400});
  const started = performance.now();
  const pending = track(host.play({token: 'slow-but-moving', text: 'A long reply on a slow computer'}, async emit => {
    for (let index = 0; index < 8; index++) { await sleep(150); await emit(packet({index: index + 1, offsetFrames: index * 9600})); }
  }, {onFrame: () => control}));
  await until(() => players[0]?.sealed);
  assert.ok(performance.now() - started > 800, 'it ran for twice the limit');
  players[0].finish(); const result = await pending; assert.equal(result.frames, 8 * 9600);
  const stuckAt = performance.now();
  const stuck = track(host.play({token: 'stuck', text: 'A producer that stops'}, async emit => {
    await emit(packet()); await new Promise(() => {});
  }, {onFrame: () => control}));
  await assert.rejects(stuck, {name: 'AbortError'});
  assert.ok(performance.now() - stuckAt >= 380, 'cut only after standing still for the whole limit');
});

test('ownedFaceCopy: rows the producer attests as unchanged are copied once and reused, the rest of the face is copied every poll, and a face without the note is copied whole', () => {
  const rows = Array.from({length: 40}, (_, index) => [index / 60, .1, .2]);
  const upper = [[0, 1], [1 / 60, 2]];
  const make = cursor => ({version: 1, requestId: 'r', duration: .7, frames: rows, modelExpressions: {version: 1, format: 'jali-upper-v1', frames: upper},
    coverage: {version: 1, audiblePositionSeconds: cursor, phoneticIntervals: []}, rows: 'geometry-1', revision: 4});
  const cache = {};
  const first = ownedFaceCopy(make(0), cache), second = ownedFaceCopy(make(.08), cache);
  assert.deepEqual(first.frames, rows); assert.notEqual(first.frames, rows, 'an owned copy, not the producer\'s array');
  assert.equal(second.frames, first.frames, 'the same copied rows on the next poll');
  assert.equal(second.modelExpressions.frames, first.modelExpressions.frames);
  assert.deepEqual(second.modelExpressions, {version: 1, format: 'jali-upper-v1', frames: upper});
  assert.equal(first.coverage.audiblePositionSeconds, 0); assert.equal(second.coverage.audiblePositionSeconds, .08, 'the small part is fresh');
  assert.equal('rows' in first, false); assert.equal('rows' in second, false); assert.equal(second.revision, 4);
  // New rows (another key) are copied again; a face without the note never shares anything.
  const grown = ownedFaceCopy({...make(.1), rows: 'geometry-2', frames: [...rows, [40 / 60, 0, 0]]}, cache);
  assert.equal(grown.frames.length, 41); assert.notEqual(grown.frames, first.frames);
  const plain = {version: 1, frames: rows, coverage: {audiblePositionSeconds: 0}};
  const one = ownedFaceCopy(plain, {}), two = ownedFaceCopy(plain, cache);
  assert.notEqual(one.frames, two.frames); assert.notEqual(one.frames, rows);
  const loose = {};
  const a = ownedFaceCopy(plain, loose), b = ownedFaceCopy(plain, loose);
  assert.notEqual(a.frames, b.frames, 'no note, no reuse, even with the same array');
});
