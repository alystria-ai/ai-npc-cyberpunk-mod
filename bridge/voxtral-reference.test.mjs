import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeWav, encodeWav16, prepareReference, createReferencePreparer, encodeMp3, REFERENCE_PREPARATION} from './voxtral-reference.mjs';
import {VoxtralVoice} from './voxtral-voice.mjs';

// A 13 s clip of 24 kHz speech-like tone with a pause at 8.0 to 8.2 s (inside the last 2.5 s before the 8.5 s cut).
const RATE = 24000;
function clip(seconds = 13) {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE, pause = t > 8.0 && t < 8.2;
    samples[i] = pause ? 0.0005 * Math.sin(i * 0.2) : 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
  }
  return encodeWav16(samples, RATE);
}

test('a reference is made mono, 16 kHz and about 8 s, cut in a pause, and is far smaller', () => {
  const source = clip(), made = prepareReference(source, REFERENCE_PREPARATION);
  const decoded = decodeWav(made.wav);
  assert.equal(decoded.rate, 16000); assert.equal(decoded.channels, 1);
  assert.ok(made.seconds > 7.9 && made.seconds <= 8.5, `seconds ${made.seconds}`);
  assert.ok(made.wav.length < source.length * 0.45, `${made.wav.length} bytes against ${source.length}`);
  // The cut falls in the pause (the clip ends quietly), not inside a tone.
  const tail = decoded.samples[0].subarray(decoded.samples[0].length - 80);
  assert.ok(Math.max(...tail.map(Math.abs)) < 0.05, 'the clip ends in a pause');
  // A clip already short enough is not cut.
  assert.ok(Math.abs(prepareReference(clip(5), REFERENCE_PREPARATION).seconds - 5) < 0.01);
  assert.throws(() => prepareReference(Buffer.from('not a wav at all, just some bytes here, long enough to try'), REFERENCE_PREPARATION), /not a WAV/);
});

test('the preparer keeps its result on disk by the source clip\'s hash and does not repeat the work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voxtral-ref-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = clip();
  let encoded = 0;
  const prepare = (extra = {}) => createReferencePreparer({cacheDirectory: directory, ffmpeg: async () => null, ...extra});
  const first = await prepare()(source, {key: 'judy-alvarez'});
  assert.equal(first.format, 'wav'); assert.equal(first.cached, false);
  assert.deepEqual((await readdir(directory)).sort(), ['judy-alvarez.json', 'judy-alvarez.wav']);
  // A new preparer (a new process) reads the cache: same bytes, no preparation.
  const second = await prepare()(source, {key: 'judy-alvarez'});
  assert.equal(second.cached, true); assert.deepEqual(second.bytes, first.bytes);
  // Another clip under the same key is prepared again; a damaged cache file is ignored.
  const other = await prepare()(clip(12), {key: 'judy-alvarez'});
  assert.equal(other.cached, false);
  await writeFile(join(directory, 'judy-alvarez.wav'), Buffer.from('damaged'));
  assert.equal((await prepare()(clip(12), {key: 'judy-alvarez'})).cached, false);
  // With ffmpeg the cache holds the MP3; a different setting (no MP3) does not reuse it.
  const fakeMp3 = Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x00]), Buffer.alloc(4000, 7)]);
  const withMp3 = prepare({ffmpeg: async () => 'ffmpeg', encode: async () => { encoded++; return fakeMp3; }});
  const mp3 = await withMp3(source, {key: 'judy-alvarez'});
  assert.equal(mp3.format, 'mp3'); assert.equal(encoded, 1);
  assert.equal((await withMp3(source, {key: 'judy-alvarez'})).cached, true); assert.equal(encoded, 1);
  assert.equal((await prepare({mp3: false})(source, {key: 'judy-alvarez'})).format, 'wav');
  assert.equal(JSON.parse(await readFile(join(directory, 'judy-alvarez.json'), 'utf8')).format, 'wav');
});

test('the reference MP3 is 32 kbit/s, and a clip prepared at another bitrate is prepared again', async t => {
  assert.equal(REFERENCE_PREPARATION.mp3Bitrate, '32k', 'the 64 kbit/s clip made Voxtral answer about 0.4 s later on the real API (docs/LATENCY_2026-10-12.md)');
  const directory = await mkdtemp(join(tmpdir(), 'voxtral-ref-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = clip();
  const fakeMp3 = Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x00]), Buffer.alloc(4000, 7)]);
  const bitrates = [];
  const prepare = settings => createReferencePreparer({cacheDirectory: directory, settings, ffmpeg: async () => 'ffmpeg',
    encode: async (wav, {bitrate}) => { bitrates.push(bitrate); return fakeMp3; }});
  assert.equal((await prepare(REFERENCE_PREPARATION)(source, {key: 'judy-alvarez'})).cached, false);
  assert.equal((await prepare(REFERENCE_PREPARATION)(source, {key: 'judy-alvarez'})).cached, true);
  assert.equal((await prepare({...REFERENCE_PREPARATION, mp3Bitrate: '64k'})(source, {key: 'judy-alvarez'})).cached, false, 'an MP3 written at 64k is not served as the 32k clip');
  assert.deepEqual(bitrates, ['32k', '64k']);
});

test('an MP3 that is not smaller or not an MP3, a failed encoder and an unwritable cache all fall back to the 16 kHz clip', async () => {
  const source = clip();
  const noisy = async () => Buffer.from('not an mp3 at all');
  const huge = async wav => Buffer.concat([Buffer.from([0xFF, 0xFB]), Buffer.alloc(wav.length + 10)]);
  for (const encode of [noisy, huge, async () => null]) {
    const made = await createReferencePreparer({cacheDirectory: null, ffmpeg: async () => 'ffmpeg', encode})(source, {key: 'judy'});
    assert.equal(made.format, 'wav');
  }
  const logs = [];
  const made = await createReferencePreparer({cacheDirectory: join(tmpdir(), 'x'), ffmpeg: async () => null, makeDirectory: async () => { throw Object.assign(Error('read-only'), {code: 'EROFS'}); },
    onLog: line => logs.push(line)})(source, {key: 'judy'});
  assert.equal(made.format, 'wav'); assert.match(logs.join(), /EROFS/);
  assert.equal(await createReferencePreparer({ffmpeg: async () => null})(Buffer.from('garbage that is not a wav, long enough to look like data'), {key: 'judy'}), null);
  assert.equal(await encodeMp3(source, {ffmpeg: null}), null);
});

test('Voxtral sends the prepared reference, tells its format and size, and falls back to the whole clip when preparation fails', async () => {
  const source = clip();
  const registry = {profiles: {judy: {reference: 'runtime/voice-references/judy.wav'}}};
  const make = prepare => new VoxtralVoice({getKey: () => 'k'.repeat(32), referenceRoot: '/refs', registry, read: async () => source, prepare});
  const small = await make(createReferencePreparer({ffmpeg: async () => null, cacheDirectory: null})).reference('judy');
  assert.equal(small.format, 'wav'); assert.ok(small.bytes < source.length * 0.45); assert.equal(small.originalBytes, source.length);
  assert.equal(Buffer.from(small.base64, 'base64').length, small.bytes);
  const whole = await make(async () => { throw Error('preparation broke'); }).reference('judy');
  assert.equal(whole.bytes, source.length); assert.equal(whole.format, 'wav');
  const unprepared = await make(undefined).reference('judy');
  assert.equal(unprepared.base64, source.toString('base64'));
  const larger = await make(async bytes => ({bytes: Buffer.concat([bytes, Buffer.alloc(10)]), format: 'wav'})).reference('judy');
  assert.equal(larger.bytes, source.length, 'a "prepared" clip that is not smaller is not used');
});
