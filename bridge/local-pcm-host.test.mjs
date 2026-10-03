import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {LocalPcmClient} from './local-pcm-client.mjs';
import {LocalPcmHost, ownedLocalPcmPacket, localSnapshotForHost} from './local-pcm-host.mjs';
import {encodePcmWav} from './convai-audio-stream.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate) {
  const deadline = performance.now() + 1500;
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

function fixture(t, {manualAck = false} = {}) {
  const pages = [], players = [], tasks = [];
  const host = new LocalPcmHost({pollMs: 5, timeoutMs: 3000, cleanupTimeoutMs: 100,
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

test('the worker ACK follows the renderer copy, and completion waits for device drain', {timeout: 5000}, async t => {
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

test('a drained page can render a fresh utterance without carrying its previous owner or text', {timeout: 5000}, async t => {
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

test('device drain during an awaited game callback cannot submit a control to the closed player', {timeout: 5000}, async t => {
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

test('native face prefixes are copied from the exact turn hook while audio continues', {timeout: 5000}, async t => {
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

test('facial prefixes follow acknowledged renderer frames while the producer has future PCM', {timeout: 5000}, async t => {
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

test('producer identity and contiguous offsets cannot change after the first owned copy', {timeout: 5000}, async t => {
  const {host, pages, track} = fixture(t);
  const pending = track(host.play({token: 'wrong-producer', text: 'Owned'}, async emit => {
    await emit(packet());
    await emit(packet({index: 2, offsetFrames: 9600, id: 2}));
  }, {onFrame: () => control}));
  await assert.rejects(pending, /Local PCM producer changed/);
  assert.equal(pages[0].closed, true); assert.equal(host.active, null); assert.equal(host.page, null);
});

test('abort cancels a thinking producer and discards its renderer before any late control', {timeout: 5000}, async t => {
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

test('a changed game owner fences late admission and cancels synthesis', {timeout: 5000}, async t => {
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

test('a failed game callback aborts the between-yields producer and discards its page', {timeout: 5000}, async t => {
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

test('overlapping local turns and foreign renderer receipts cannot be admitted', {timeout: 5000}, async t => {
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

test('a cancelled factory cannot donate its late page to a new turn', {timeout: 5000}, async () => {
  const creating = deferred(), controller = new AbortController();
  let closes = 0;
  const host = new LocalPcmHost({createPage: () => creating.promise, commandTimeoutMs: 100});
  const pending = host.play({token: 'cancelled-factory', text: 'Owned'}, () => {},
    {signal: controller.signal, onFrame: () => control});
  pending.catch(() => {});
  await sleep(10); controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
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
