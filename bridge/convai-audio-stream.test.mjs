import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PcmChunkStream, ConvaiAudioStream, encodePcmWav, sliceFaces} from './convai-audio-stream.mjs';
import {SpeechSlots} from './speech-stream.mjs';
import {inspectWav} from './speech-audio.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const tick = () => new Promise(done => setImmediate(done));
const metadata = {text: 'Hey V. We have a lot to talk about.', textComplete: true,
  sessionID: 'session-one', faces: [], captions: [], timing: {firstAudioMs: 250}};
const pcm = (seconds, value = .1) => new Float32Array(Math.round(seconds * 8000)).fill(value);
function chunk(index, startSeconds, duration = 1, extra = {}) {
  return {version: 1, index, startSeconds, duration, audio: encodePcmWav(pcm(duration), 8000),
    ...metadata, ...extra};
}

test('first real PCM segment is emitted before completion, and concatenated samples exactly match the old WAV conversion', async () => {
  const output = [], stream = new PcmChunkStream({sampleRate: 8000, chunkSeconds: 2, emit: async value => output.push(value)});
  const original = Float32Array.from({length: 8000 * 5 + 37}, (_, index) => Math.sin(index / 9) * .6);
  stream.update(metadata);
  for (let at = 0; at < 8800; at += 800) stream.push(original.subarray(at, at + 800));
  await stream.pump();
  assert.equal(output.length, 1); assert(output[0].duration >= .988 && output[0].duration <= 1);
  assert.equal(stream.finalRequested, false);
  for (let at = 8800; at < original.length; at += 777) {
    stream.push(original.subarray(at, Math.min(original.length, at + 777))); await stream.pump();
  }
  const result = await stream.finish(metadata);
  assert.equal(result.chunks, 3);
  assert.equal(result.duration, original.length / 8000);
  const joined = Buffer.concat(output.map(row => Buffer.from(row.audio, 'base64').subarray(44)));
  assert.deepEqual(joined, Buffer.from(encodePcmWav(original, 8000), 'base64').subarray(44));
  assert.equal(output[1].startSeconds, output[0].duration);
  assert(Math.abs(output[2].startSeconds - output[0].duration - output[1].duration) < 1e-9);
  assert.equal(stream.parts.length, 0); assert.equal(stream.buffered, 0);
});

test('a native file cut uses a nearby real zero crossing without changing or losing samples', async () => {
  const rows = [], stream = new PcmChunkStream({sampleRate: 8000, emit: async row => rows.push(row)});
  const original = pcm(1.2, .2);
  original[7951] = .0001; original[7952] = -.0001;
  stream.update(metadata); stream.push(original); await stream.pump(); await stream.finish(metadata);
  assert.equal(rows[0].duration, 7952 / 8000);
  assert.equal(rows[1].startSeconds, rows[0].duration);
  assert.deepEqual(Buffer.concat(rows.map(row => Buffer.from(row.audio, 'base64').subarray(44))),
    Buffer.from(encodePcmWav(original, 8000), 'base64').subarray(44));
});

test('caption text is nonempty and cumulative, while a short reply produces one valid final segment', async () => {
  const output = [], stream = new PcmChunkStream({sampleRate: 8000, emit: async row => output.push(row)});
  stream.push(pcm(.4)); await stream.pump();
  assert.equal(output.length, 0);
  await stream.finish({...metadata, text: 'Hey, V.'});
  assert.equal(output.length, 1); assert.equal(output[0].text, 'Hey, V.'); assert.equal(output[0].duration, .4);
  assert.throws(() => stream.push(pcm(.1)), /after capture completed/);
});

test('default realtime-sized segments do not require a longer second buffer and introduce a one-second underrun', async () => {
  let time = 0;
  const emitted = [], stream = new PcmChunkStream({sampleRate: 8000, now: () => time,
    emit: async row => emitted.push({ready: time / 1000, duration: row.duration})});
  stream.update(metadata);
  for (let index = 0; index < 41; index++) {
    time += 100; stream.push(pcm(.1)); await stream.pump();
  }
  assert.equal(emitted.length, 4);
  for (let index = 1; index < emitted.length; index++) {
    assert(emitted[index].ready <= emitted[index - 1].ready + emitted[index - 1].duration + .001);
  }
  await stream.finish(metadata);
});

test('a slow native consumer limits captured PCM and fails instead of dropping or retaining unbounded audio', async () => {
  let acknowledge;
  const output = [], stream = new PcmChunkStream({sampleRate: 8000, maxBufferedSeconds: 4,
    emit: row => { output.push(row); return new Promise(done => { acknowledge = done; }); }});
  stream.update(metadata); stream.push(pcm(3));
  const pending = stream.pump(); pending.catch(() => {}); await tick();
  assert.equal(output.length, 1);
  stream.push(pcm(1));
  assert.throws(() => stream.push(pcm(.05)), /fell behind/);
  await assert.rejects(pending, /fell behind/);
  acknowledge(); await tick();
  assert.equal(output.length, 1); assert.equal(stream.parts.length, 0);
});

test('cancellation during an awaiting chunk prevents all later emission and final success', async () => {
  let acknowledge;
  const output = [], stream = new PcmChunkStream({sampleRate: 8000,
    emit: row => { output.push(row); return new Promise(done => { acknowledge = done; }); }});
  stream.update(metadata); stream.push(pcm(4));
  const pending = stream.pump(); pending.catch(() => {}); await tick();
  stream.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  acknowledge(); await tick();
  await assert.rejects(stream.finish(metadata), {name: 'AbortError'});
  assert.equal(output.length, 1);
});

test('facial segments use chunk-local audio time without restarting or stretching missing frames', () => {
  const frames = Array.from({length: 121}, (_, index) => ({at: index / 30, values: Array(61).fill(index / 120)}));
  const slice = sliceFaces(frames, 1.01, 2.91);
  assert.equal(slice[0].at, 0); assert(Math.abs(slice[0].values[0] - 1.01 / 4) < 1e-9);
  assert(Math.abs(slice.at(-1).at - 1.9) < 1e-9);
  assert(Math.abs(slice.at(-1).values[0] - 2.91 / 4) < 1e-9);
  assert(slice.every((frame, index) => !index || frame.at > slice[index - 1].at));
  assert.deepEqual(sliceFaces([frames[0], frames[120]], 1, 2), []);
  assert.deepEqual(sliceFaces([{at: 0, values: Array(61).fill(NaN)}], 0, 1), []);
});

test('per-chunk spoken events are offset to that chunk and do not get repeated on later chunks', async () => {
  const rows = [], stream = new PcmChunkStream({sampleRate: 8000, chunkSeconds: 2, emit: async row => rows.push(row)});
  const meta = {...metadata, captions: [{at: .1, text: 'Hey V.'}, {at: 1.3, text: 'Another sentence.'}]};
  stream.update(meta); stream.push(pcm(3.1)); await stream.pump(); await stream.finish(meta);
  assert.deepEqual(rows[0].captions, [{at: .1, text: 'Hey V.'}]);
  assert.equal(rows[1].captions.length, 1); assert(Math.abs(rows[1].captions[0].at - .3) < 1e-9);
  assert.equal(rows[1].captions[0].text, 'Another sentence.');
  assert.equal(rows[2].captions.length, 0);
});

function publisher() {
  const h = {state: {}, current: true, writes: [], manifests: [], waiters: [], time: Date.now()};
  const input = {requestId: 'request-one', generation: 4, entity: 'judy-copy'};
  const slots = new SpeechSlots({depot: 'unused', readState: async () => h.state,
    store: async (audio, depot, slot) => {
      assert.notEqual(slot, h.state.requestId && h.state.slot);
      h.writes.push(slot); return {slot, event: `convai_reply_${slot}`, ...inspectWav(Buffer.from(audio, 'base64'))};
    }});
  h.stream = new ConvaiAudioStream({input, streamId: 'stream-one', slots, current: async () => h.current,
    readState: async () => h.state, writeManifest: async doc => h.manifests.push(structuredClone(doc)),
    buildFace: row => ({source: 'fixture', at: row.startSeconds}), now: () => h.time,
    wait: () => new Promise(done => h.waiters.push(done))});
  h.ack = (completed, extra = {}) => {
    h.state = {streamId: 'stream-one', requestId: input.requestId, state: 'playing', updated: h.time,
      completedChunk: completed, slot: h.writes[completed], ...extra};
    h.waiters.splice(0).forEach(done => done());
  };
  return h;
}

test('native manifest starts without a guessed total and finalizes without publishing the first chunk twice', async () => {
  const h = publisher();
  const first = await h.stream.append(chunk(1, 0));
  assert.equal(first.index, 1); assert.equal(h.writes.length, 1);
  assert.equal(h.stream.descriptor().version, 2); assert.equal(h.stream.descriptor().total, null);
  assert.equal(h.manifests[0].bufferedDuration, 1); assert.equal(h.manifests[0].complete, false);
  h.ack(0); await h.stream.append(chunk(2, 1));
  await h.stream.finish({streamed: true, stream: {chunks: 2, duration: 2}, text: 'The final complete reply.'});
  assert.equal(h.writes.length, 2);
  assert.equal(h.manifests.at(-1).complete, true); assert.equal(h.manifests.at(-1).total, 2);
  assert.equal(h.manifests.at(-1).text, 'The final complete reply.');
  await h.stream.finish({}); // idempotent after final manifest
  assert.equal(h.manifests.length, 3);
});

test('publisher backpressure protects native slots and rejects stale consumer ownership', async () => {
  const h = publisher();
  await h.stream.append(chunk(1, 0)); h.ack(0);
  await h.stream.append(chunk(2, 1)); await h.stream.append(chunk(3, 2));
  const blocked = h.stream.append(chunk(4, 3)); blocked.catch(() => {}); await tick();
  assert.equal(h.writes.length, 3);
  h.ack(0, {paused: true}); await tick(); assert.equal(h.writes.length, 3);
  h.ack(1); await blocked; assert.equal(h.writes.length, 4);
  h.ack(1, {requestId: 'another-request'});
  await assert.rejects(h.stream.append(chunk(5, 4)), {name: 'AbortError'});
  assert.equal(h.writes.length, 4);
});

test('native errors preserve only actually published segments and cancellation publishes nothing new', async () => {
  const h = publisher(); await h.stream.append(chunk(1, 0));
  await h.stream.fail(Error('network disappeared'));
  assert.equal(h.manifests.at(-1).complete, true); assert.equal(h.manifests.at(-1).total, 1);
  assert.match(h.manifests.at(-1).error, /rest of the voice/);
  const second = publisher(); await second.stream.append(chunk(1, 0));
  second.current = false;
  await second.stream.fail(Error('old world disconnected'));
  assert.equal(second.manifests.length, 1);
});

test('malformed indices, discontinuous clocks and final duration mismatches cannot be committed', async () => {
  const h = publisher();
  await assert.rejects(h.stream.append(chunk(2, 0)), /Invalid realtime/);
  await h.stream.append(chunk(1, 0));
  await assert.rejects(h.stream.append(chunk(2, .5)), /Invalid realtime/);
  await assert.rejects(h.stream.finish({streamed: true, stream: {chunks: 1, duration: 5}, text: 'Hello'}), /Incomplete/);
  assert.equal(h.manifests.at(-1).complete, false);
});

test('all host operations reject the retired audio callback before starting a browser', async () => {
  const host = new RealtimeHost(), config = {characterId: 'judy'};
  let starts = 0; host.start = async () => { starts++; };
  const onAudioChunk = async () => {};
  await assert.rejects(host.reply(config, {onAudioChunk}), /Chunked Convai playback is retired/);
  await assert.rejects(host.reply({...config, ttsEnabled: false}, {onAudioChunk}), /Chunked Convai playback is retired/);
  await assert.rejects(host.warm(config, {onAudioChunk}), /Chunked Convai playback is retired/);
  await assert.rejects(host.prepare(config, {onAudioChunk}), /Chunked Convai playback is retired/);
  await assert.rejects(host.reply(config, {onAudioChunk: null}), /Chunked Convai playback is retired/);
  assert.equal(starts, 0);
  assert.equal(host.acceptAudio, undefined);
  assert.equal(host.audioSinks, undefined);
});

test('a pooled complete reply cannot forward caller supplied legacy stream tokens', async () => {
  const host = new RealtimeHost(), released = [];
  host.start = async () => {};
  const page = {evaluate: async (fn, {config, method}) => {
    assert.equal(method, 'reply'); assert.equal(config.audioStreamToken, undefined);
    assert.deepEqual(host.connectOwners.get(page), {characterId: 'judy', endUserId: 'current-branch', ttsEnabled: true});
    return {text: metadata.text, sessionID: metadata.sessionID, audio: 'complete-wav', streamed: false};
  }};
  host.pool = {entries: new Map([['one', {}]]), acquire: async () => ({value: page, reused: true,
    release: async options => released.push(options)})};
  const supplied = {characterId: 'judy', endUserId: 'current-branch', scope: 'private', audioStreamToken: 'untrusted-token'};
  const result = await host.reply(supplied);
  assert.equal(result.streamed, false); assert.equal(result.audio, 'complete-wav');
  assert.equal(result.timing.pageReused, true);
  assert.equal(released.length, 1); assert.equal(!!released[0].discard, false);
  assert.equal(supplied.audioStreamToken, 'untrusted-token');
});

test('host microphone context refresh uses the owned lease and rejects identity changes before evaluation', async () => {
  const original = {characterId: 'judy', endUserId: 'save-one', scope: 'private', ttsEnabled: true};
  for (const change of [null, {characterId: 'panam'}, {endUserId: 'save-two'}, {scope: 'group:judy,panam'},
    {ttsEnabled: false}, {sessionId: 'foreign-session'}, {freshSession: true}]) {
    const host = new RealtimeHost(), owner = {}, evaluated = [], released = [];
    host.voiceLease = {owner, config: original, epoch: host.epoch, sessionID: 'mic-session',
      value: {evaluate: async (fn, config) => { evaluated.push(config); return {sessionID: 'mic-session', text: 'Hello'}; },
        context: () => ({clearPermissions: async () => {}})},
      release: async options => released.push(options)};
    const fresh = {...original, sessionId: 'mic-session', context: 'Fresh facts', ...change};
    if (!change) {
      assert.equal((await host.finishVoice(owner, fresh)).text, 'Hello');
      assert.equal(evaluated[0].context, 'Fresh facts'); assert.equal(released[0].discard, false);
    } else {
      await assert.rejects(host.finishVoice(owner, fresh), /identity changed|speculative preparation/);
      assert.equal(evaluated.length, 0); assert.equal(released[0].discard, true);
    }
    assert.equal(host.voiceLease, null);
  }
});
