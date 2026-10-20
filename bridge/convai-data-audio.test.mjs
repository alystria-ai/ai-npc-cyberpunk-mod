import test from 'node:test';
import assert from 'node:assert/strict';
import {ConvaiDataAudio} from './convai-data-audio.mjs';
import {readPcmWav} from './speech-audio.mjs';

const owner = {response_id: 'isolated-response', neurosync_turn_id: 1, epoch: 1};
const other = {response_id: 'other-response', neurosync_turn_id: 2, epoch: 1};
const wire = data => ({label: 'rtvi-ai', type: 'server-message', data});
const samples = Buffer.alloc(6400);
for (let index = 0; index < 3200; index++) samples.writeInt16LE([-32768, -1, 0, 1, 32767][index % 5], index * 2);
const pcm = (bytes = samples, extra = {}) => wire({type: 'audio-data', sample_rate: 8000,
  channels: 1, audio: bytes.toString('base64'), includes_wav_header: false, ...extra});
const face = (start = 0, count = 24, extra = {}) => wire({type: 'chunked-neurosync-blendshapes',
  ...owner, fps: 60, start_frame_index: start,
  blendshapes: Array.from({length: count}, (_, index) => Array.from({length: 61}, (_, key) => ((index + start + key) % 8) / 8)), ...extra});
const stats = (extra = {}, own = owner) => wire({type: 'blendshape-turn-stats', ...own, sequence: 19,
  stats: {total_audio_bytes: 6400, total_blendshapes: 24, fps: 60, total_audio_duration_ms: 400,
    was_interrupted: false, ...extra}});
const terminal = (extra = {}) => wire({type: 'bot-turn-completed', ...owner, sequence: 18,
  was_interrupted: false, ...extra});
const feed = (collector, message, atMs = 0, kind = 0) => collector.accept(message, {atMs, kind});
function complete({audio = pcm(), faces = face(), statistics = stats(), end = terminal()} = {}) {
  const c = new ConvaiDataAudio();
  feed(c, faces, 10); feed(c, audio, 20); feed(c, statistics, 30); feed(c, end, 40);
  return c;
}

test('incremental PCM waits for a verified owner and drains each exact packet once with sample offsets', () => {
  const c = new ConvaiDataAudio();
  feed(c, pcm(samples.subarray(0, 3200)), 10);
  assert.deepEqual(c.drainPcm(), [], 'unowned PCM cannot enter playback');
  feed(c, face(), 11);
  const first = c.drainPcm();
  assert.equal(first.length, 1); assert.equal(first[0].offsetFrames, 0);
  assert.deepEqual(Buffer.from(first[0].bytes), samples.subarray(0, 3200));
  assert.deepEqual(c.drainPcm(), []);
  // The caller may transfer or mutate its copy without damaging archival PCM.
  first[0].bytes.fill(99);
  feed(c, pcm(samples.subarray(3200)), 20);
  const second = c.drainPcm();
  assert.equal(second[0].offsetFrames, 1600);
  assert.deepEqual(Buffer.from(second[0].bytes), samples.subarray(3200));
  feed(c, stats(), 21); feed(c, terminal(), 22);
  assert.deepEqual(readPcmWav(Buffer.from(c.finish().audio, 'base64')).data, samples);
});

test('continuous finish validates exact totals without encoding a WAV and retains indexed faces for playback', () => {
  const c = complete();
  assert.equal(c.progress().sourceComplete, true);
  c.drainPcm();
  const result = c.finish({includeAudio: false});
  assert.equal(Object.hasOwn(result, 'audio'), false);
  assert.equal(result.faces.length, 24);
  assert.deepEqual(c.progress().faces, result.faces);
  assert.equal(c.progress().receivedFrames, 3200);
  assert.equal(c.progress().sourceComplete, true);
  assert.deepEqual(c.drainPcm(), []);
});

test('progressive PCM cannot drain after ownership failure or cancellation', () => {
  for (const action of ['cancel', 'foreign']) {
    const c = new ConvaiDataAudio(); feed(c, face(), 1); feed(c, pcm(), 2);
    if (action === 'cancel') c.abort('Cancelled before admission');
    else assert.throws(() => feed(c, terminal({...other}), 3), /replaced/);
    assert.throws(() => c.drainPcm());
    assert.equal(c.progress().faces.length, 0);
  }
});

test('one WAV preserves every source PCM byte, sample rate, channel and signed endpoint', () => {
  const c = new ConvaiDataAudio();
  feed(c, face(), 10);
  feed(c, pcm(samples.subarray(0, 3200)), 20);
  feed(c, pcm(samples.subarray(3200)), 40);
  feed(c, stats(), 42); feed(c, terminal(), 43);
  const result = c.finish(), decoded = readPcmWav(Buffer.from(result.audio, 'base64'));
  assert.deepEqual(decoded.data, samples);
  assert.equal(decoded.sampleRate, 8000); assert.equal(decoded.channels, 1); assert.equal(decoded.bits, 16);
  assert.equal(result.duration, 0.4); assert.equal(result.packetCount, 2);
  assert.deepEqual(result.timing, {firstFaceMs: 10, completeFaceMs: 10, firstAudioMs: 20,
    completeAudioMs: 40, collectionCompleteMs: 43});
  assert.equal(result.faces[12].at, 0.2);
  assert.strictEqual(c.finish(), result);
});

test('declared stats may precede final PCM; matching terminal alone cannot publish a truncated WAV', () => {
  const c = new ConvaiDataAudio();
  feed(c, face(), 10); feed(c, pcm(samples.subarray(0, 3200)), 20);
  feed(c, stats(), 30); feed(c, terminal(), 40);
  assert.equal(c.ready, false); assert.throws(() => c.finish(), /complete audio/);
  feed(c, pcm(samples.subarray(3200)), 50);
  assert.equal(c.ready, true); assert.equal(c.finish().timing.collectionCompleteMs, 50);
});

test('stats sequence19 before terminal18 is valid, facial indices order the 60fps timeline', () => {
  const c = new ConvaiDataAudio();
  feed(c, face(12, 12, {sequence: 4}), 10);
  feed(c, face(0, 12, {sequence: 1}), 11);
  feed(c, pcm(), 12); feed(c, stats(), 13); feed(c, terminal(), 14);
  const result = c.finish();
  assert.equal(result.faces.length, 24);
  assert.equal(result.faces[1].at, 1 / 60);
  assert.deepEqual(result.faces[0].values, face(0, 1).data.blendshapes[0]);
});

test('UTF8 full envelopes work and unrelated RTVI messages do not close the turn', () => {
  const c = new ConvaiDataAudio();
  const encoded = new TextEncoder().encode(JSON.stringify(pcm()));
  feed(c, encoded, 1);
  assert.equal(feed(c, {label: 'rtvi-ai', type: 'bot-llm-stopped', data: {}}, 2), false);
  assert.equal(feed(c, {label: 'rtvi-ai', type: 'bot-tts-stopped', data: {}}, 3), false);
  assert.equal(feed(c, {label: 'rtvi-ai', type: 'bot-started-speaking', data: {}}, 3), false);
  assert.equal(feed(c, {label: 'rtvi-ai', type: 'bot-stopped-speaking', data: {}}, 3), false);
  feed(c, face(), 4); feed(c, stats(), 5);
  assert.equal(c.ready, false);
  feed(c, terminal(), 6); assert.equal(c.ready, true);
});

test('repeated identical PCM is retained, not content-deduplicated', () => {
  const c = new ConvaiDataAudio(), half = Buffer.alloc(3200, 0);
  feed(c, pcm(half), 1); feed(c, pcm(half), 2);
  feed(c, face(), 3); feed(c, stats(), 4); feed(c, terminal(), 5);
  assert.equal(readPcmWav(Buffer.from(c.finish().audio, 'base64')).data.length, 6400);
});

test('stereo interleaving survives byte-for-byte without mono folding', () => {
  const c = complete({audio: pcm(samples, {channels: 2}), faces: face(0, 12),
    statistics: stats({total_blendshapes: 12, total_audio_duration_ms: 200})});
  const decoded = readPcmWav(Buffer.from(c.finish().audio, 'base64'));
  assert.equal(decoded.channels, 2); assert.deepEqual(decoded.data, samples);
});

test('known retired metadata is ignored; another current owner is a fatal boundary', () => {
  const c = new ConvaiDataAudio({retiredOwners: [other]});
  assert.equal(feed(c, stats({}, other)), false);
  feed(c, face(), 1); feed(c, pcm(), 2); feed(c, stats(), 3); feed(c, terminal(), 4);
  assert.equal(c.ready, true);
  const changed = new ConvaiDataAudio(); feed(changed, face());
  assert.throws(() => feed(changed, terminal(other), 1), /replaced the active speech owner/);
  assert.equal(changed.ready, false);
});

test('a refused owner says which identifier fields differed and how far the active response had got, never an identifier or text', () => {
  const c = new ConvaiDataAudio(); feed(c, face(), 1); feed(c, pcm(), 2);
  assert.throws(() => feed(c, terminal(other), 3), error => {
    assert.match(error.message, /^Convai replaced the active speech owner \(bot-turn-completed; response_id differs, neurosync_turn_id differs, epoch same; the active response had 1 audio packets, no statistics, no end\)$/);
    assert(!error.message.includes(owner.response_id) && !error.message.includes(other.response_id));
    return true;
  });
  // a message that carries only the other identifier field is told apart from one that carries a different value
  const only = new ConvaiDataAudio();
  feed(only, wire({type: 'chunked-neurosync-blendshapes', neurosync_turn_id: 1, fps: 60, start_frame_index: 0,
    blendshapes: Array.from({length: 2}, () => Array(61).fill(0))}), 1);
  assert.throws(() => feed(only, wire({type: 'bot-turn-completed', response_id: 'late-response', was_interrupted: false}), 2),
    /\(bot-turn-completed; response_id new, neurosync_turn_id absent in the new message, epoch none; the active response had 0 audio packets, no statistics, no end\)/);
});

test('cross-epoch reused response ID does not pass owner matching', () => {
  const c = new ConvaiDataAudio(); feed(c, face());
  assert.throws(() => feed(c, terminal({epoch: 2}), 1), /replaced the active speech owner/);
});

test('ownerless terminal is rejected; source PCM itself need not carry an owner', () => {
  const c = new ConvaiDataAudio(); feed(c, pcm());
  assert.throws(() => feed(c, wire({type: 'bot-turn-completed', was_interrupted: false}), 1), /no response owner/);
});

test('interruptions, aborts and matching facial cancellation never produce a WAV', () => {
  for (const end of [terminal({was_interrupted: true}), terminal({was_aborted: true}),
    wire({type: 'neurosync-blendshapes-cancel', ...owner, valid_through_frame_index: 2})]) {
    const c = new ConvaiDataAudio(); feed(c, face()); feed(c, pcm()); feed(c, stats());
    assert.throws(() => feed(c, end), /interrupted|aborted|cancelled/);
    assert.throws(() => c.finish(), /interrupted|aborted|cancelled/);
  }
});

test('transport closure and local cancellation reject partial delivery and ignore tails', () => {
  for (const cancel of [c => c.transportClosed(), c => c.abort('explicit cancellation')]) {
    const c = new ConvaiDataAudio(); feed(c, pcm(samples.subarray(0, 3200)), 1); cancel(c);
    assert.equal(feed(c, pcm(samples.subarray(3200)), 2), false);
    assert.throws(() => c.finish(), /closed|cancellation/);
  }
  const done = complete(); done.transportClosed(); assert.ok(done.finish().audio);
});

test('missing source data, stats, or terminal has no silence-based completion', () => {
  for (const omit of ['audio', 'stats', 'terminal']) {
    const c = new ConvaiDataAudio(); feed(c, face());
    if (omit !== 'audio') feed(c, pcm());
    if (omit !== 'stats') feed(c, stats());
    if (omit !== 'terminal') feed(c, terminal());
    assert.equal(c.ready, false); assert.throws(() => c.finish(), /complete audio/);
  }
});

test('invalid PCM payload, WAV flag, alignment and unsupported format are rejected', () => {
  const invalid = [pcm(samples, {audio: '!!=='}), pcm(samples, {audio: ''}),
    pcm(Buffer.alloc(3)), pcm(samples, {includes_wav_header: true}),
    pcm(samples, {sample_rate: 0}), pcm(samples, {sample_rate: 8000.5}),
    pcm(samples, {channels: 0}), pcm(samples, {channels: 3})];
  for (const message of invalid) {
    const c = new ConvaiDataAudio(); assert.throws(() => feed(c, message), /PCM|samples/);
    assert.ok(c.error); assert.equal(c.parts.length, 0);
  }
});

test('rate/channel change or unreliable data cannot silently corrupt the reply', () => {
  for (const change of [{sample_rate: 24000}, {channels: 2}]) {
    const c = new ConvaiDataAudio(); feed(c, pcm(samples.subarray(0, 3200)));
    assert.throws(() => feed(c, pcm(samples.subarray(3200), change), 1), /changed PCM format/);
  }
  assert.throws(() => feed(new ConvaiDataAudio(), pcm(), 0, 1), /reliable ordered/);
});

test('byte and duration ceilings reject overflow before WAV allocation', () => {
  assert.throws(() => feed(new ConvaiDataAudio({maxBytes: 6398}), pcm()), /collection limit/);
  assert.throws(() => feed(new ConvaiDataAudio({maxSeconds: 0.3}), pcm()), /collection limit/);
  assert.throws(() => new ConvaiDataAudio({maxBytes: 24000001}), /limits/);
  assert.throws(() => new ConvaiDataAudio({maxSeconds: 121}), /limits/);
});

test('source counts and declared duration must agree; excess samples fail', () => {
  const wrongDuration = new ConvaiDataAudio(); feed(wrongDuration, pcm());
  assert.throws(() => feed(wrongDuration, stats({total_audio_duration_ms: 500})), /declared duration/);
  const excess = new ConvaiDataAudio(); feed(excess, stats()); feed(excess, pcm());
  assert.throws(() => feed(excess, pcm(Buffer.alloc(2))), /declared output size/);
  const conflict = new ConvaiDataAudio(); feed(conflict, stats());
  assert.throws(() => feed(conflict, stats({total_audio_bytes: 8000, total_audio_duration_ms: 500})), /Conflicting/);
});

test('a declared duration a few milliseconds off from the counted bytes is rounding and still plays', () => {
  // 6400 bytes at 8 kHz mono is exactly 400 ms; 12 ms off is per-packet rounding drift, 6 frames of 60 fps data stay valid too.
  for (const ms of [388, 395, 400, 405, 412]) {
    const c = complete({statistics: stats({total_audio_duration_ms: ms})});
    assert.equal(c.ready, true, `${ms} ms`);
    const result = c.finish();
    assert.equal(result.duration, 0.4);
    assert.equal(result.facialDiagnostic, undefined, `${ms} ms keeps its facial data`);
  }
});

test('a wrong sample rate or channel count still fails, with the numbers in the message', () => {
  // 6400 bytes declared as 800 ms is 16 kHz data read as 8 kHz: far outside rounding.
  const wrongRate = new ConvaiDataAudio(); feed(wrongRate, pcm());
  assert.throws(() => feed(wrongRate, stats({total_audio_duration_ms: 800})),
    /declared duration \(6400 bytes, 800 ms declared against 400\.0 ms counted, 8000 Hz, 1 channel, 1 packets\)/);
  const wrongChannels = new ConvaiDataAudio(); feed(wrongChannels, pcm(samples, {channels: 2}));
  assert.throws(() => feed(wrongChannels, stats({total_audio_duration_ms: 400})), /declared duration \(6400 bytes, 400 ms declared against 200\.0 ms counted, 8000 Hz, 2 channels/);
});

// 2026-10-21 reports (Multilingual on): packets that say 24 kHz carrying 44.1 kHz audio. 5,733 ms declared against 10,535 ms counted at the declared rate is exactly 44100 / 24000.
const mislabelled = ({bytes = 505652, ms = 5733, said = 24000, frames = 344} = {}) => {
  const c = new ConvaiDataAudio(), data = Buffer.alloc(bytes);
  for (let index = 0; index < bytes / 2; index++) data.writeInt16LE([-3000, -1, 0, 1, 3000][index % 5], index * 2);
  const half = Math.floor(bytes / 4) * 2;
  feed(c, face(0, frames), 10);
  feed(c, pcm(data.subarray(0, half), {sample_rate: said}), 20); feed(c, pcm(data.subarray(half), {sample_rate: said}), 30);
  return {c, data, finish: () => { feed(c, stats({total_audio_bytes: bytes, total_blendshapes: frames, total_audio_duration_ms: ms}), 40); feed(c, terminal(), 41); return c; }};
};

test('packets that say 24 kHz but carry 44.1 kHz audio (the declared duration and the bytes agree on it) are written and played at 44.1 kHz, and the clip is complete', () => {
  const {c, data, finish} = mislabelled();
  assert.equal(c.sampleRate, 24000, 'until the statistics arrive the packets\' own rate stands');
  finish();
  assert.equal(c.ready, true); assert.equal(c.error, null);
  assert.deepEqual(c.rateCorrected, {declared: 24000, actual: 44100});
  assert.equal(c.progress().sampleRate, 44100);
  const result = c.finish(), decoded = readPcmWav(Buffer.from(result.audio, 'base64'));
  assert.equal(decoded.sampleRate, 44100); assert.deepEqual(decoded.data, data);
  assert(Math.abs(result.duration - 5.733) < 0.001, 'the duration of the audio, not 10.5 s');
  assert.deepEqual(result.sampleRateCorrected, {declared: 24000, actual: 44100});
  assert.equal(result.faces.length, 344, 'the faces stay valid');
});

test('the same for 48 kHz audio labelled 24 kHz, and a clip whose label is right is untouched (no correction recorded)', () => {
  const {c, finish} = mislabelled({bytes: 288000, ms: 3000, frames: 180});
  finish();
  assert.deepEqual(c.rateCorrected, {declared: 24000, actual: 48000});
  assert.equal(readPcmWav(Buffer.from(c.finish().audio, 'base64')).sampleRate, 48000);
  const right = mislabelled({bytes: 288000, ms: 6000, frames: 360, said: 24000});
  right.finish();
  assert.equal(right.c.rateCorrected, null); assert.equal(right.c.finish().sampleRateCorrected, undefined);
  assert.equal(right.c.finish().sampleRate, 24000);
});

test('a rate that is not a standard one, or off by more than half a percent, is still a fault, flagged as a format fault; faults of ownership are not', () => {
  // 32 kHz data labelled 24 kHz, and 44.1 kHz data declared 1 percent too long: not mislabelling.
  for (const options of [{bytes: 384000, ms: 6000, frames: 360}, {bytes: 505652, ms: 5790, frames: 347}]) {
    const {c} = mislabelled(options);
    assert.throws(() => feed(c, stats({total_audio_bytes: options.bytes, total_blendshapes: options.frames, total_audio_duration_ms: options.ms}), 40), /declared duration/);
    assert.equal(c.error.formatFault, true);
    assert.equal(c.rateCorrected, null);
  }
  const unsupported = new ConvaiDataAudio();
  assert.throws(() => feed(unsupported, pcm(samples, {sample_rate: 0})), /Unsupported/);
  assert.equal(unsupported.error.formatFault, true);
  const owners = new ConvaiDataAudio(); feed(owners, face(), 1);
  assert.throws(() => feed(owners, terminal({...other}), 3), /replaced/);
  assert.equal(owners.error.formatFault, undefined);
  const unreliable = new ConvaiDataAudio();
  assert.throws(() => feed(unreliable, pcm(), 0, 1), /reliable ordered/);
  assert.equal(unreliable.error.formatFault, undefined);
});

test('declared bytes that are not a whole number of samples fail clearly', () => {
  const c = new ConvaiDataAudio(); feed(c, pcm());
  assert.throws(() => feed(c, stats({total_audio_bytes: 6401})), /not a whole number of samples \(6401 bytes/);
});

test('incomplete or malformed face data cannot discard otherwise verified voice', () => {
  const malformed = face(); malformed.data.blendshapes[0] = [0];
  for (const facial of [face(0, 12), face(1, 23), malformed,
    face(0, 24, {fps: 30}), face(0, 24, {fps: 0})]) {
    const c = complete({faces: facial});
    assert.equal(c.ready, true);
    const result = c.finish();
    assert.deepEqual(readPcmWav(Buffer.from(result.audio, 'base64')).data, samples);
    assert.deepEqual(result.faces, []); assert.ok(result.facialDiagnostic);
  }
});

test('duplicate facial frames do not double their duration, conflicting duplicates disable faces only', () => {
  const c = new ConvaiDataAudio(); feed(c, face()); feed(c, face(), 1);
  feed(c, pcm(), 2); feed(c, stats(), 3); feed(c, terminal(), 4);
  assert.equal(c.finish().faces.length, 24);
  const conflict = new ConvaiDataAudio(); feed(conflict, face());
  const altered = face(); altered.data.blendshapes[0][0] = 0.9;
  feed(conflict, altered, 1); feed(conflict, pcm(), 2); feed(conflict, stats(), 3); feed(conflict, terminal(), 4);
  assert.match(conflict.finish().facialDiagnostic, /Conflicting/);
});

test('invalid facial final counts and absent facial chunks leave original voice available', () => {
  for (const facialStats of [{fps: 0}, {total_blendshapes: 0}, {total_blendshapes: 99}]) {
    const c = complete({statistics: stats(facialStats)});
    const result = c.finish(); assert.ok(result.audio); assert.ok(result.facialDiagnostic); assert.equal(result.faces.length, 0);
  }
  const c = new ConvaiDataAudio(); feed(c, pcm()); feed(c, stats()); feed(c, terminal());
  assert.match(c.finish().facialDiagnostic, /incomplete/);
});

test('sealed results cannot be mutated by late data, and no native chunk is exposed', () => {
  const c = complete(), result = c.finish();
  assert.equal(feed(c, pcm()), false); assert.strictEqual(c.finish(), result);
  assert.equal(result.stream, undefined); assert.equal(result.streamed, undefined);
  assert.equal(c.parts.length, 0); assert.equal(c.frames.size, 0);
});

test('actual mixed wire envelopes finish on the top-level owned terminal event', () => {
  const c = new ConvaiDataAudio();
  feed(c, face(0, 14, {sequence: 1}), 10);
  feed(c, {label: 'rtvi-ai', type: 'bot-started-speaking', data: {...owner, sequence: 3}}, 12);
  feed(c, face(14, 10, {sequence: 4}), 14);
  feed(c, pcm(), 20); feed(c, stats(), 21);
  feed(c, {label: 'rtvi-ai', type: 'bot-stopped-speaking', data: {...owner, sequence: 17}}, 22);
  assert.equal(c.ready, false);
  feed(c, {label: 'rtvi-ai', type: 'bot-turn-completed', data: {...owner, sequence: 18, was_interrupted: false}}, 23);
  assert.equal(c.ready, true);
  const result = c.finish();
  assert.deepEqual(readPcmWav(Buffer.from(result.audio, 'base64')).data, samples);
  assert.equal(result.faces.length, 24);
  assert.equal(result.timing.collectionCompleteMs, 23);
});

test('outer lifecycle type cannot be replaced by a contradictory nested type', () => {
  const c = new ConvaiDataAudio(); feed(c, face()); feed(c, pcm()); feed(c, stats());
  assert.throws(() => feed(c, {label: 'rtvi-ai', type: 'bot-stopped-speaking',
    data: {...owner, type: 'bot-turn-completed', was_interrupted: false}}), /Conflicting.*types/);
  assert.equal(c.ready, false);
  const valid = new ConvaiDataAudio(); feed(valid, face()); feed(valid, pcm()); feed(valid, stats());
  feed(valid, {label: 'rtvi-ai', type: 'bot-turn-completed', data: terminal().data});
  assert.equal(valid.ready, true);
});
