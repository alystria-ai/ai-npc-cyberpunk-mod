// bridge/prepared-audio.mjs: the container sniff, the Ogg and FLAC header reads, the decode plan, the decoder routes (all with fakes), the bounded decode cache and,
// when ffmpeg happens to be on this computer, one real Opus round trip.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readdir, rm, writeFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {PREPARED_AUDIO, createDecodeCache, createPreparedAudio, evictionPlan, findRuntimePython, fromS16, oggPageAt, parseFlac, parseOgg, planPrepared,
  pipeWavToMono, runPythonDecoder, sniffContainer, toS16, wavToMono, PYTHON_DECODER} from './prepared-audio.mjs';
import {wavToPcm} from './omni-pcm.mjs';
import {findFfmpeg} from './voxtral-reference.mjs';

// ---- fixtures: hand-made containers (headers only, the bodies are not audio) ----
function wavOf(samples, rate = 24000) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  return bytes;
}
const tone = (count, hz = 220, rate = 24000) => Float32Array.from({length: count}, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / rate));
function page({flags = 0, granule = 0n, serial = 7, sequence = 0, body = Buffer.alloc(0)}) {
  const segments = []; let left = body.length;
  while (left >= 255) { segments.push(255); left -= 255; }
  segments.push(left);
  const head = Buffer.alloc(27 + segments.length);
  head.write('OggS'); head[4] = 0; head[5] = flags; head.writeBigInt64LE(BigInt(granule), 6); head.writeUInt32LE(serial, 14); head.writeUInt32LE(sequence, 18);
  head[26] = segments.length; segments.forEach((value, i) => { head[27 + i] = value; });
  return Buffer.concat([head, body]);
}
function opusHead({channels = 1, preSkip = 312, family = 0, version = 1} = {}) {
  const body = Buffer.alloc(19); body.write('OpusHead'); body[8] = version; body[9] = channels; body.writeUInt16LE(preSkip, 10); body.writeUInt32LE(44100, 12); body[18] = family; return body;
}
function vorbisId({channels = 1, rate = 44100, version = 0} = {}) {
  const body = Buffer.alloc(30); body[0] = 1; body.write('vorbis', 1); body.writeUInt32LE(version, 7); body[11] = channels; body.writeUInt32LE(rate, 12); return body;
}
const oggOf = (head, lastGranule, extra = []) => Buffer.concat([page({flags: 2, body: head}), page({sequence: 1, granule: 0n, body: Buffer.from('tags')}), ...extra,
  page({flags: 4, sequence: 9, granule: lastGranule, body: Buffer.alloc(40, 1)})]);
function flacOf({rate = 44100, channels = 1, total = 44100} = {}) {
  const bytes = Buffer.alloc(42); bytes.write('fLaC'); bytes[4] = 0x80; bytes.writeUIntBE(34, 5, 3);
  bytes[18] = rate >> 12; bytes[19] = (rate >> 4) & 255; bytes[20] = ((rate & 15) << 4) | ((channels - 1) << 1);
  bytes[21] = Math.floor(total / 2 ** 32) & 15; bytes.writeUInt32BE(total % 2 ** 32, 22); return bytes;
}

test('the container comes from the first bytes', () => {
  assert.equal(sniffContainer(wavOf(tone(480))), 'wav');
  assert.equal(sniffContainer(oggOf(opusHead(), 48000n)), 'ogg');
  assert.equal(sniffContainer(flacOf()), 'flac');
  assert.equal(sniffContainer(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)])), 'mp3');
  assert.equal(sniffContainer(Buffer.from('this is a text file, not audio')), null);
  assert.equal(sniffContainer(Buffer.alloc(3)), null);
});

test('an Ogg page header reads its fields and refuses what is not a page', () => {
  const bytes = page({flags: 2, granule: 123n, serial: 9, sequence: 4, body: Buffer.alloc(300, 1)});
  const read = oggPageAt(bytes, 0);
  assert.deepEqual({flags: read.flags, granule: read.granule, serial: read.serial, sequence: read.sequence, bodyBytes: read.bodyBytes, end: read.end}, {flags: 2, granule: 123n, serial: 9, sequence: 4, bodyBytes: 300, end: bytes.length});
  assert.equal(oggPageAt(bytes, 3), null);
  assert.equal(oggPageAt(Buffer.from('OggS\u0001'.padEnd(40, '\0'), 'latin1'), 0), null, 'version 1 is not Ogg');
  assert.equal(oggPageAt(bytes, -1), null);
});

test('Opus: channels, the 48 kHz output rate and the length from the last granule position minus the pre-skip', () => {
  const info = parseOgg(oggOf(opusHead({channels: 2, preSkip: 312}), 48312n * 3n));
  assert.deepEqual(info, {codec: 'opus', channels: 2, sampleRate: 48000, seconds: (48312 * 3 - 312) / 48000});
  assert.equal(parseOgg(oggOf(opusHead({preSkip: 5000}), 100n)).seconds, 0, 'a position inside the pre-skip is no length below zero');
});

test('Vorbis: channels, the rate in the header, the length from the last granule position', () => {
  assert.deepEqual(parseOgg(oggOf(vorbisId({channels: 1, rate: 44100}), 88200n)), {codec: 'vorbis', channels: 1, sampleRate: 44100, seconds: 2});
});

test('an Ogg that is not usable is refused from its headers, before any decoder', () => {
  const flacInOgg = Buffer.concat([page({flags: 2, body: Buffer.concat([Buffer.from([0x7f]), Buffer.from('FLAC'), Buffer.alloc(30)])})]);
  assert.throws(() => parseOgg(flacInOgg), /neither Opus nor Vorbis/);
  assert.throws(() => parseOgg(oggOf(opusHead({channels: 3}), 100n)), /mono or stereo/);
  assert.throws(() => parseOgg(oggOf(opusHead({channels: 6, family: 1}), 100n)), /mono or stereo/);
  assert.throws(() => parseOgg(oggOf(opusHead({channels: 0}), 100n)), /mono or stereo/);
  assert.throws(() => parseOgg(oggOf(opusHead({version: 0x20}), 100n)), /version/);
  assert.throws(() => parseOgg(oggOf(vorbisId({version: 1}), 100n)), /version/);
  assert.throws(() => parseOgg(oggOf(vorbisId({rate: 100}), 100n)), /sample rate/);
  assert.throws(() => parseOgg(Buffer.from('OggS' + '\0'.repeat(60), 'latin1')), /complete Ogg/);
  assert.throws(() => parseOgg(page({body: opusHead()})), /complete Ogg/, 'the first page must begin the stream');
  assert.throws(() => parseOgg(oggOf(opusHead(), 99000000000000n)), /impossible length/);
});

test('the length survives a last page with no position and a final page that was cut off', () => {
  const noPosition = oggOf(opusHead({preSkip: 0}), -1n, [page({sequence: 5, granule: 96000n, body: Buffer.alloc(20, 2)})]);
  // the last page claims -1 (no packet ends on it): the page before it (96000) is the answer
  assert.equal(parseOgg(noPosition).seconds, 2);
  const whole = oggOf(opusHead({preSkip: 0}), 48000n * 4n);
  assert.equal(parseOgg(whole.subarray(0, whole.length - 10)).seconds, 0, 'only the tag page (position 0) is complete');
  const none = Buffer.concat([page({flags: 2, body: opusHead()})]);
  assert.equal(parseOgg(none).seconds, 0);
  assert.equal(parseOgg(Buffer.concat([page({flags: 2, granule: -1n, body: opusHead()}), Buffer.alloc(30)])).seconds, null, 'no page has a position: unknown');
});

test('FLAC: rate, channels and length from the STREAMINFO block', () => {
  assert.deepEqual(parseFlac(flacOf({rate: 44100, channels: 2, total: 88200})), {codec: 'flac', channels: 2, sampleRate: 44100, seconds: 2});
  assert.equal(parseFlac(flacOf({total: 0})).seconds, null);
  assert.throws(() => parseFlac(flacOf({channels: 6})), /mono or stereo/);
  assert.throws(() => parseFlac(Buffer.from('fLaC')), /complete FLAC/);
});

test('the plan: wav needs no tool, the others need a decoder, a bad file is refused with a sentence', () => {
  assert.deepEqual(planPrepared(wavOf(tone(24000))), {container: 'wav', codec: 'pcm', channels: 1, sampleRate: 24000, seconds: 1, route: 'wav'});
  assert.deepEqual(planPrepared(oggOf(opusHead({preSkip: 0}), 96000n)), {container: 'ogg', codec: 'opus', channels: 1, sampleRate: 48000, seconds: 2, route: 'external'});
  assert.equal(planPrepared(flacOf()).route, 'external');
  assert.deepEqual(planPrepared(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)])), {container: 'mp3', codec: 'mp3', channels: null, sampleRate: null, seconds: null, route: 'external'});
  assert.throws(() => planPrepared(Buffer.alloc(0)), /empty/);
  assert.throws(() => planPrepared(null), /empty/);
  assert.throws(() => planPrepared(Buffer.from('plain words, nothing else here')), /not a WAV, Ogg, FLAC or MP3/);
  assert.throws(() => planPrepared(Buffer.alloc(100, 1), {maxBytes: 50}), /too large/);
  assert.throws(() => planPrepared(Buffer.concat([Buffer.from('RIFF....WAVE'), Buffer.alloc(40)])), /not a supported PCM WAV/);
});

test('the 60 second limit is checked from the headers, without decoding', () => {
  assert.doesNotThrow(() => planPrepared(oggOf(opusHead({preSkip: 0}), 48000n * 60n)));
  assert.throws(() => planPrepared(oggOf(opusHead({preSkip: 0}), 48000n * 61n)), /longer than 60 seconds/);
  assert.throws(() => planPrepared(flacOf({rate: 48000, total: 48000 * 70})), /longer than 60 seconds/);
  assert.throws(() => planPrepared(wavOf(tone(24000 * 10)), {maxSeconds: 5}), /longer than 5 seconds/);
  assert.doesNotThrow(() => planPrepared(oggOf(opusHead({preSkip: 0}), 48000n * 200n), {maxSeconds: 300}), 'a music bed has its own limit');
});

test('wavToMono: 24 kHz is wavToPcm itself, another rate is interpolated to that many samples, stereo is averaged', () => {
  const source = wavOf(tone(2400));
  assert.deepEqual(wavToMono(source), wavToPcm(source));
  const up = wavToMono(source, 48000);
  assert.equal(up.length, 4800);
  assert.ok(Math.abs(up[2] - wavToPcm(source)[1]) < 0.02);
  const frames = 800, stereo = Buffer.alloc(44 + frames * 4); stereo.write('RIFF'); stereo.writeUInt32LE(stereo.length - 8, 4); stereo.write('WAVEfmt ', 8);
  stereo.writeUInt32LE(16, 16); stereo.writeUInt16LE(1, 20); stereo.writeUInt16LE(2, 22); stereo.writeUInt32LE(8000, 24); stereo.writeUInt32LE(32000, 28);
  stereo.writeUInt16LE(4, 32); stereo.writeUInt16LE(16, 34); stereo.write('data', 36); stereo.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i += 2) { stereo.writeInt16LE(16384, 44 + i * 4); stereo.writeInt16LE(-16384, 46 + i * 4); stereo.writeInt16LE(16384, 48 + i * 4); stereo.writeInt16LE(16384, 50 + i * 4); }
  const mono = wavToMono(stereo, 8000);
  assert.equal(mono.length, frames);
  assert.ok(Math.abs(mono[0]) < 1e-6 && Math.abs(mono[1] - 0.5) < 1e-4);
  assert.throws(() => wavToMono(Buffer.from('nope')));
});

// ---- the decoder, with fakes ----
const opusFile = seconds => oggOf(opusHead({preSkip: 0}), BigInt(Math.round(48000 * seconds)));
function fakes({ffmpeg = 'ffmpeg-fake', converted = () => wavOf(tone(24000)), python = null, pythonSamples = () => tone(12000), cache = null} = {}) {
  const calls = {ffmpeg: 0, convert: [], python: []};
  const audio = createPreparedAudio({
    ffmpeg: async () => { calls.ffmpeg++; return ffmpeg; },
    convert: async (bytes, command, options) => { calls.convert.push({command, options, length: bytes.length}); return converted(bytes); },
    python: () => python, runPython: async (interpreter, bytes, options) => { calls.python.push({interpreter, options, length: bytes.length}); return pythonSamples(); },
    cache});
  return {audio, calls};
}

test('a WAV is decoded in JavaScript: no ffmpeg, no Python, no cache', async () => {
  const {audio, calls} = fakes();
  const samples = await audio.decode(wavOf(tone(2400)));
  assert.equal(samples.length, 2400);
  assert.deepEqual(calls, {ffmpeg: 0, convert: [], python: []});
  await assert.rejects(audio.decode(Buffer.from('not audio at all, honest')), /not a WAV, Ogg, FLAC or MP3/);
  await assert.rejects(audio.decode(wavOf(tone(24000 * 3)), {maxSeconds: 2}), /longer than 2 seconds/);
});

test('an Ogg goes to ffmpeg first, at the wanted rate, with a cut-off one second past the limit', async () => {
  const {audio, calls} = fakes({python: '/py'});
  const samples = await audio.decode(opusFile(1));
  assert.equal(samples.length, 24000);
  assert.deepEqual(calls.convert.map(call => [call.command, call.options]), [['ffmpeg-fake', {rate: 24000, seconds: 61}]]);
  assert.equal(calls.python.length, 0, 'Python is the second route only');
  const music = await audio.decode(opusFile(2), {rate: 48000, maxSeconds: 300});
  assert.ok(music.length > 0);
  assert.deepEqual(calls.convert.at(-1).options, {rate: 48000, seconds: 301});
});

test('with no ffmpeg, or one that fails, the Runtime Python is tried; with neither the error says what to install or ship', async () => {
  const noFfmpeg = fakes({ffmpeg: null, python: '/runtime/python.exe'});
  const viaPython = await noFfmpeg.audio.decode(opusFile(1));
  assert.equal(viaPython.length, 12000);
  assert.equal(noFfmpeg.calls.python[0].interpreter, '/runtime/python.exe');
  assert.deepEqual(noFfmpeg.calls.python[0].options, {rate: 24000, limitFrames: 61 * 24000});
  const failing = fakes({converted: () => null, python: '/runtime/python.exe'});
  assert.equal((await failing.audio.decode(opusFile(1))).length, 12000, 'ffmpeg failed: Python decodes');
  const neither = fakes({ffmpeg: null});
  await assert.rejects(neither.audio.decode(opusFile(1)), /needs ffmpeg on this computer or the Runtime Python with the soundfile package, otherwise the pack must ship WAV/);
  const broken = fakes({converted: () => null, python: '/py', pythonSamples: () => null});
  await assert.rejects(broken.audio.decode(opusFile(1)), /could not be decoded/);
  const garbled = fakes({converted: () => Buffer.from('not a wav'), python: null});
  await assert.rejects(garbled.audio.decode(opusFile(1)), /could not be decoded/);
});

test('a decoder that returns nothing, or more than the limit, or non-finite samples, is handled', async () => {
  await assert.rejects(fakes({ffmpeg: null, python: '/py', pythonSamples: () => new Float32Array(0)}).audio.decode(opusFile(1)), /could not be decoded|decoded to nothing/);
  await assert.rejects(fakes({converted: () => wavOf(tone(24000 * 5))}).audio.decode(opusFile(1), {maxSeconds: 2}), /longer than 2 seconds/);
  const odd = Float32Array.from([0.1, NaN, Infinity, -0.2]);
  const cleaned = await fakes({ffmpeg: null, python: '/py', pythonSamples: () => odd}).audio.decode(opusFile(1));
  assert.deepEqual([...cleaned], [Math.fround(0.1), 0, 0, Math.fround(-0.2)].map(Number));
});

test('a file is converted once: the cache answers the second ask', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prepared-audio-'));
  try {
    const cache = createDecodeCache({directory});
    const first = fakes({cache}), file = opusFile(1);
    const a = await first.audio.decode(file);
    await new Promise(done => setTimeout(done, 50));
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.s16')).length, 1);
    const second = fakes({cache});
    const b = await second.audio.decode(file);
    assert.equal(second.calls.ffmpeg, 0, 'no decoder was asked');
    assert.equal(b.length, a.length);
    assert.ok(Math.abs(b[100] - a[100]) < 1e-4, 'kept as 16 bit samples');
    const other = await fakes({cache}).audio.decode(file, {rate: 48000});
    assert.ok(other.length > 0);
    await new Promise(done => setTimeout(done, 50));
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.s16')).length, 2, 'the rate is part of the key');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the cache is bounded and evicts the oldest files', async () => {
  const rows = [{name: 'a', size: 10, mtimeMs: 5}, {name: 'b', size: 10, mtimeMs: 1}, {name: 'c', size: 10, mtimeMs: 3}, {name: 'd', size: 10, mtimeMs: 2}];
  assert.deepEqual(evictionPlan(rows, {maxFiles: 10, maxBytes: 1000}), []);
  assert.deepEqual(evictionPlan(rows, {maxFiles: 2, maxBytes: 1000}), ['b', 'd']);
  assert.deepEqual(evictionPlan(rows, {maxFiles: 10, maxBytes: 25}), ['b', 'd']);
  assert.deepEqual(evictionPlan([], {}), []);
  const directory = await mkdtemp(join(tmpdir(), 'prepared-audio-'));
  try {
    const cache = createDecodeCache({directory, maxFiles: 2});
    const sha = n => String(n).padStart(64, '0');
    await cache.put(sha(1), 24000, tone(100)); await utimes(join(directory, `${sha(1)}-24000.s16`), new Date(1000), new Date(1000));
    await cache.put(sha(2), 24000, tone(100)); await utimes(join(directory, `${sha(2)}-24000.s16`), new Date(2000), new Date(2000));
    await cache.put(sha(3), 24000, tone(100));
    assert.deepEqual((await readdir(directory)).sort(), [`${sha(2)}-24000.s16`, `${sha(3)}-24000.s16`]);
    assert.equal(await cache.get(sha(1), 24000), null);
    assert.equal((await cache.get(sha(3), 24000)).length, 100);
    await writeFile(join(directory, 'notes.txt'), 'kept: not a cache file');
    await cache.put(sha(4), 24000, tone(100));
    assert.ok((await readdir(directory)).includes('notes.txt'), 'only cache files are ever removed');
  } finally { await rm(directory, {recursive: true, force: true}); }
  assert.throws(() => createDecodeCache({}), /folder/);
  const broken = createDecodeCache({directory: join(tmpdir(), 'x'), fs: {mkdir: async () => { throw Error('no'); }}});
  assert.equal(await broken.put('a'.repeat(64), 24000, tone(10)), false, 'a cache that cannot write only means decoding again');
  assert.equal(await broken.get('a'.repeat(64), 24000), null);
  assert.deepEqual([...fromS16(toS16(Float32Array.from([0, 0.5, -0.5, 2, -2])))].map(value => Math.round(value * 100) / 100), [0, 0.5, -0.5, 1, -1]);
});

test('the WAV an external decoder streams to a pipe (sizes left at 0xFFFFFFFF) is read', () => {
  const streamed = Buffer.from(wavOf(tone(2400))); streamed.writeUInt32LE(0xFFFFFFFF, 4); streamed.writeUInt32LE(0xFFFFFFFF, 40);
  assert.equal(pipeWavToMono(streamed, 24000).length, 2400);
  assert.equal(pipeWavToMono(streamed, 48000).length, 4800);
  assert.throws(() => pipeWavToMono(Buffer.from('nope')), /cannot read/);
});

test('the Python route: -I, the numbers as arguments, the bytes through the pipe, mono float32 back', async () => {
  const seen = {};
  const run = (command, args, options, callback) => {
    Object.assign(seen, {command, args, options});
    const written = [];
    queueMicrotask(() => { const out = Buffer.alloc(8); out.writeFloatLE(0.25, 0); out.writeFloatLE(-0.5, 4); callback(null, out); });
    return {on() {}, stdin: {on() {}, end: bytes => written.push(bytes)}, written};
  };
  const samples = await runPythonDecoder('/runtime/python.exe', Buffer.from('FILE'), {rate: 24000, limitFrames: 1440000, run});
  assert.deepEqual([...samples], [0.25, -0.5]);
  assert.equal(seen.command, '/runtime/python.exe');
  assert.deepEqual(seen.args, ['-I', '-c', PYTHON_DECODER, '24000', '1440000']);
  assert.equal(seen.options.cwd, tmpdir(), 'not run from a folder with downloaded files');
  assert.ok(!PYTHON_DECODER.includes('open('), 'the program reads stdin and never a path');
  for (const bad of [(c, a, o, cb) => { cb(Error('exit 3'), Buffer.alloc(0)); return {}; }, (c, a, o, cb) => { cb(null, Buffer.alloc(5)); return {}; }, () => { throw Error('spawn'); }]) {
    assert.equal(await runPythonDecoder('/p', Buffer.from('x'), {rate: 24000, limitFrames: 100, run: bad}), null);
  }
  assert.equal(await runPythonDecoder(null, Buffer.from('x'), {rate: 24000, limitFrames: 100}), null);
});

test('the Runtime Python is the one the launcher names, when it exists', () => {
  const exists = path => path === 'C:\\Runtime\\app\\omni\\python\\python.exe';
  const win = process.platform === 'win32';
  assert.equal(findRuntimePython({env: {}, exists}), null);
  assert.equal(findRuntimePython({env: {CYBERPUNK_CONVAI_PYTHON: 'relative/python'}, exists: () => true}), null, 'never a relative path');
  if (win) {
    assert.equal(findRuntimePython({env: {CYBERPUNK_CONVAI_PYTHON: 'C:\\Runtime\\app\\omni\\python\\python.exe'}, exists}), 'C:\\Runtime\\app\\omni\\python\\python.exe');
    assert.equal(findRuntimePython({env: {CYBERPUNK_CONVAI_PYTHON: 'C:\\Runtime\\missing\\python.exe'}, exists}), null);
  }
});

test('defaults: a line is 24 kHz and at most 60 seconds', () => {
  assert.equal(PREPARED_AUDIO.rate, 24000);
  assert.equal(PREPARED_AUDIO.maxSeconds, 60);
});

// ---- one real round trip, only where ffmpeg is installed ----
const ffmpeg = await findFfmpeg();
test('real ffmpeg: an Opus file is read by its header and decoded to the wanted samples', {skip: ffmpeg ? false : 'ffmpeg is not installed on this computer'}, async () => {
  const run = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), 'prepared-audio-real-'));
  try {
    const out = join(directory, 'tone.opus');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5:sample_rate=48000', '-c:a', 'libopus', '-b:a', '32k', out]);
    const {readFile} = await import('node:fs/promises');
    const bytes = await readFile(out);
    const plan = planPrepared(bytes);
    assert.equal(plan.codec, 'opus'); assert.equal(plan.route, 'external');
    assert.ok(Math.abs(plan.seconds - 1.5) < 0.05, `header length ${plan.seconds}`);
    const samples = await createPreparedAudio().decode(bytes);
    assert.ok(Math.abs(samples.length / 24000 - 1.5) < 0.1, `decoded length ${samples.length / 24000}`);
    let peak = 0; for (const value of samples) peak = Math.max(peak, Math.abs(value));
    assert.ok(peak > 0.1 && peak <= 1, `peak ${peak}`);
    const music = await createPreparedAudio().decode(bytes, {rate: 48000, maxSeconds: 300});
    assert.ok(Math.abs(music.length / 48000 - 1.5) < 0.1);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
