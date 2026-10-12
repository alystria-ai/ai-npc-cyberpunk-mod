import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeWav, encodeWav16, prepareReference, createReferencePreparer, encodeMp3, findFfmpeg, REFERENCE_PREPARATION} from './voxtral-reference.mjs';
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

test('a reference is made mono, 24 kHz and about 8 s, cut in a pause, and is smaller', () => {
  const source = clip(), made = prepareReference(source, REFERENCE_PREPARATION);
  const decoded = decodeWav(made.wav);
  assert.equal(decoded.rate, 24000); assert.equal(decoded.channels, 1);
  assert.ok(made.seconds > 7.9 && made.seconds <= 8.5, `seconds ${made.seconds}`);
  assert.ok(made.wav.length < source.length * 0.7, `${made.wav.length} bytes against ${source.length}`);   // 8.5 s of a 13 s clip
  // The cut falls in the pause (the clip ends quietly), not inside a tone.
  const tail = decoded.samples[0].subarray(decoded.samples[0].length - 80);
  assert.ok(Math.max(...tail.map(Math.abs)) < 0.05, 'the clip ends in a pause');
  // A clip already short enough is not cut.
  assert.ok(Math.abs(prepareReference(clip(5), REFERENCE_PREPARATION).seconds - 5) < 0.01);
  assert.throws(() => prepareReference(Buffer.from('not a wav at all, just some bytes here, long enough to try'), REFERENCE_PREPARATION), /not a WAV/);
});

// Voxtral's answer has only the frequencies its reference had (docs/CLOUD_VOICE_VOXTRAL.md, 2026-10-13): at 16 kHz the clone stopped at 7.5 kHz.
function toneEnergy(samples, rate, hz) {            // Goertzel power of one frequency, per sample
  const w = 2 * Math.PI * hz / rate, c = 2 * Math.cos(w);
  let a = 0, b = 0;
  for (const x of samples) { const t = x + c * a - b; b = a; a = t; }
  return (a * a + b * b - c * a * b) / samples.length / samples.length;
}
test('the reference keeps the 8 to 11 kHz band of the clip, which a 16 kHz reference loses', () => {
  const samples = new Float32Array(Math.round(10 * RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = 0.2 * Math.sin(2 * Math.PI * 300 * i / RATE) + 0.1 * Math.sin(2 * Math.PI * 10000 * i / RATE);
  const source = encodeWav16(samples, RATE);
  const kept = decodeWav(prepareReference(source, REFERENCE_PREPARATION).wav).samples[0];
  const old = decodeWav(prepareReference(source, {...REFERENCE_PREPARATION, targetRate: 16000}).wav).samples[0];
  const ratio = (clip, rate) => toneEnergy(clip.subarray(2000, 40000), rate, 10000) / toneEnergy(clip.subarray(2000, 40000), rate, 300);
  const original = toneEnergy(samples.subarray(2000, 40000), RATE, 10000) / toneEnergy(samples.subarray(2000, 40000), RATE, 300);
  assert.ok(Math.abs(10 * Math.log10(ratio(kept, 24000) / original)) < 0.5, 'the 10 kHz content is unchanged');
  assert.ok(ratio(old, 16000) < original * 0.001, 'a 16 kHz reference has nothing at 10 kHz (the old behaviour)');
});

test('the reference MP3 is a 24 kHz stream (MPEG-2 layer III), so its encoder low-pass is near 10.5 kHz and not 7.3 kHz', async t => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return t.skip('ffmpeg is not on this machine');
  const mp3 = await encodeMp3(prepareReference(clip(), REFERENCE_PREPARATION).wav, {ffmpeg});
  assert.ok(mp3 && mp3.length > 1000);
  let at = mp3.toString('latin1', 0, 3) === 'ID3' ? 10 + ((mp3[6] << 21) | (mp3[7] << 14) | (mp3[8] << 7) | mp3[9]) : 0;
  while (at < mp3.length - 4 && !(mp3[at] === 0xFF && (mp3[at + 1] & 0xE0) === 0xE0)) at++;
  const version = (mp3[at + 1] >> 3) & 3, rateIndex = (mp3[at + 2] >> 2) & 3;
  assert.equal(version, 2, 'MPEG-2'); assert.equal(rateIndex, 1, '24000 Hz');
  assert.ok(mp3.length < 60000, `${mp3.length} bytes`);
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

test('the reference MP3 is 40 kbit/s at 24 kHz, and a clip prepared at another bitrate is prepared again', async t => {
  // 64 kbit/s made Voxtral answer about 0.4 s later in the 2026-10-12 runs (docs/LATENCY_2026-10-12.md); 32 kbit/s at 16 kHz had nothing above 7.5 kHz.
  assert.equal(REFERENCE_PREPARATION.mp3Bitrate, '40k'); assert.equal(REFERENCE_PREPARATION.targetRate, 24000); assert.equal(REFERENCE_PREPARATION.version, 3);
  const directory = await mkdtemp(join(tmpdir(), 'voxtral-ref-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = clip();
  const fakeMp3 = Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x00]), Buffer.alloc(4000, 7)]);
  const bitrates = [];
  const prepare = settings => createReferencePreparer({cacheDirectory: directory, settings, ffmpeg: async () => 'ffmpeg',
    encode: async (wav, {bitrate}) => { bitrates.push(bitrate); return fakeMp3; }});
  assert.equal((await prepare(REFERENCE_PREPARATION)(source, {key: 'judy-alvarez'})).cached, false);
  assert.equal((await prepare(REFERENCE_PREPARATION)(source, {key: 'judy-alvarez'})).cached, true);
  assert.equal((await prepare({...REFERENCE_PREPARATION, mp3Bitrate: '64k'})(source, {key: 'judy-alvarez'})).cached, false, 'an MP3 written at 64k is not served as the 40k clip');
  assert.deepEqual(bitrates, ['40k', '64k']);
});

test('an MP3 that is not smaller or not an MP3, a failed encoder and an unwritable cache all fall back to the WAV clip', async () => {
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
  assert.equal(small.format, 'wav'); assert.ok(small.bytes < source.length * 0.7); assert.equal(small.originalBytes, source.length);
  assert.equal(Buffer.from(small.base64, 'base64').length, small.bytes);
  const whole = await make(async () => { throw Error('preparation broke'); }).reference('judy');
  assert.equal(whole.bytes, source.length); assert.equal(whole.format, 'wav');
  const unprepared = await make(undefined).reference('judy');
  assert.equal(unprepared.base64, source.toString('base64'));
  const larger = await make(async bytes => ({bytes: Buffer.concat([bytes, Buffer.alloc(10)]), format: 'wav'})).reference('judy');
  assert.equal(larger.bytes, source.length, 'a "prepared" clip that is not smaller is not used');
});
