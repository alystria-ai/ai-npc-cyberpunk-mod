import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeWav, encodeWav16, prepareReference, createReferencePreparer, encodeMp3, encodeVorbis, findFfmpeg, REFERENCE_PREPARATION} from './voxtral-reference.mjs';
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

const FAKE_OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(4000, 7)]);
const FAKE_MP3 = Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x00]), Buffer.alloc(4000, 7)]);

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

test('the second-choice reference MP3 is a 24 kHz stream (MPEG-2 layer III), not the 16 kHz one whose low-pass was 7.3 kHz', async t => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return t.skip('ffmpeg is not on this machine');
  const mp3 = await encodeMp3(prepareReference(clip(), REFERENCE_PREPARATION).wav, {ffmpeg});
  assert.ok(mp3 && mp3.length > 1000);
  let at = mp3.toString('latin1', 0, 3) === 'ID3' ? 10 + ((mp3[6] << 21) | (mp3[7] << 14) | (mp3[8] << 7) | mp3[9]) : 0;
  while (at < mp3.length - 4 && !(mp3[at] === 0xFF && (mp3[at + 1] & 0xE0) === 0xE0)) at++;
  const version = (mp3[at + 1] >> 3) & 3, rateIndex = (mp3[at + 2] >> 2) & 3;
  assert.equal(version, 2, 'MPEG-2'); assert.equal(rateIndex, 1, '24000 Hz');
  assert.ok(mp3.length < 80000, `${mp3.length} bytes`);   // 64 kbit/s
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
  // With ffmpeg the cache holds the Ogg; a different setting (no compression) does not reuse it.
  const withOgg = prepare({ffmpeg: async () => 'ffmpeg', encode: async () => { encoded++; return FAKE_OGG; }});
  const ogg = await withOgg(source, {key: 'judy-alvarez'});
  assert.equal(ogg.format, 'ogg'); assert.equal(encoded, 1);
  assert.ok((await readdir(directory)).includes('judy-alvarez.ogg'));
  assert.equal((await withOgg(source, {key: 'judy-alvarez'})).cached, true); assert.equal(encoded, 1);
  assert.equal((await prepare({compress: false})(source, {key: 'judy-alvarez'})).format, 'wav');
  assert.equal((await prepare({mp3: false})(source, {key: 'judy-alvarez'})).format, 'wav', 'the name version 3 used still works');
  assert.equal(JSON.parse(await readFile(join(directory, 'judy-alvarez.json'), 'utf8')).format, 'wav');
});

test('the reference is Ogg Vorbis q2 at 24 kHz, MP3 64k is the second choice, and a clip prepared with other settings is prepared again', async t => {
  // MP3 stops at 10.5 kHz (40k) to 11.3 kHz (48k and up) and sounded dull next to the whole clip's answers; 16 kHz stopped at 7.5 kHz (2026-10-13).
  assert.equal(REFERENCE_PREPARATION.codec, 'vorbis'); assert.equal(REFERENCE_PREPARATION.vorbisQuality, 2); assert.equal(REFERENCE_PREPARATION.mp3Bitrate, '64k');
  assert.equal(REFERENCE_PREPARATION.targetRate, 24000); assert.equal(REFERENCE_PREPARATION.version, 4);
  const directory = await mkdtemp(join(tmpdir(), 'voxtral-ref-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = clip();
  const calls = [];
  const prepare = settings => createReferencePreparer({cacheDirectory: directory, settings, ffmpeg: async () => 'ffmpeg',
    encode: async (wav, {codec, quality, bitrate}) => { calls.push([codec, codec === 'vorbis' ? quality : bitrate]); return FAKE_OGG; }});
  assert.equal((await prepare(REFERENCE_PREPARATION)(source, {key: 'judy-alvarez'})).cached, false);
  assert.equal((await prepare(REFERENCE_PREPARATION)(source, {key: 'judy-alvarez'})).cached, true);
  assert.equal((await prepare({...REFERENCE_PREPARATION, vorbisQuality: 4})(source, {key: 'judy-alvarez'})).cached, false, 'an Ogg written at q4 is not served as the q2 clip');
  assert.deepEqual(calls, [['vorbis', 2], ['vorbis', 4]]);
  // The signature is the cache's own: the release builder compares it, and a safe-format (MP3) clip has another one.
  const preparer = createReferencePreparer({cacheDirectory: null});
  assert.notEqual(preparer.signature('a'.repeat(64)), preparer.signature('a'.repeat(64), {safeFormat: true}));
  assert.equal(preparer.signature('a'.repeat(64)), createReferencePreparer({cacheDirectory: null}).signature('a'.repeat(64)));
});

test('when Ogg cannot be made the MP3 is tried, then the WAV; safeFormat goes straight to the MP3', async () => {
  const source = clip(), logs = [];
  const order = [];
  const make = encode => createReferencePreparer({cacheDirectory: null, ffmpeg: async () => 'ffmpeg', onLog: line => logs.push(line),
    encode: async (wav, {codec}) => { order.push(codec); return encode(codec, wav); }});
  const noVorbis = await make(codec => codec === 'vorbis' ? null : FAKE_MP3)(source, {key: 'judy'});
  assert.equal(noVorbis.format, 'mp3'); assert.deepEqual(order, ['vorbis', 'mp3']); assert.match(logs.join(), /vorbis encoding of the reference failed or was not smaller; trying mp3/);
  order.length = 0;
  const safe = await make(codec => codec === 'vorbis' ? FAKE_OGG : FAKE_MP3)(source, {key: 'judy', safeFormat: true});
  assert.equal(safe.format, 'mp3'); assert.deepEqual(order, ['mp3'], 'the refused format is not tried again');
  order.length = 0;
  assert.equal((await make(() => null)(source, {key: 'judy'})).format, 'wav'); assert.deepEqual(order, ['vorbis', 'mp3']);
});

test('the reference Ogg is a mono 24 kHz Vorbis stream of about 38 KB, and the same clip gives the same bytes', async t => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return t.skip('ffmpeg is not on this machine');
  const wav = prepareReference(clip(), REFERENCE_PREPARATION).wav;
  const ogg = await encodeVorbis(wav, {ffmpeg});
  if (!ogg) return t.skip('this ffmpeg has no libvorbis');
  assert.equal(ogg.toString('latin1', 0, 4), 'OggS');
  const at = ogg.indexOf(Buffer.from('\x01vorbis', 'latin1'));
  assert.ok(at > 0 && at < 80, 'the identification header');
  assert.equal(ogg.readUInt8(at + 11), 1, 'mono'); assert.equal(ogg.readUInt32LE(at + 12), 24000, '24 kHz');
  assert.ok(ogg.length < wav.length / 4, `${ogg.length} bytes against ${wav.length}`);
  assert.deepEqual(await encodeVorbis(wav, {ffmpeg}), ogg, 'bit-exact: the release builder and a player make the same file');
  assert.equal(await encodeVorbis(wav, {ffmpeg: null}), null);
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

test('a player without ffmpeg reads the Ogg slot the release shipped (no encode, no ffmpeg lookup) and, with no slot, falls back to the 16-bit WAV', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voxtral-ref-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = clip();
  // The release builder's side: ffmpeg present, the slot written into <voices>/prepared.
  const shipped = createReferencePreparer({cacheDirectory: directory, ffmpeg: async () => 'ffmpeg', encode: async () => FAKE_OGG});
  const made = await shipped(source, {key: 'judy-alvarez'});
  assert.equal(made.format, 'ogg');
  // The player's side: no ffmpeg anywhere, and an encoder that must never run.
  let looked = 0;
  const player = createReferencePreparer({cacheDirectory: directory, ffmpeg: async () => { looked++; return null; }, encode: async () => { throw Error('must not encode'); }});
  const read = await player(source, {key: 'judy-alvarez'});
  assert.equal(read.cached, true); assert.equal(read.format, 'ogg'); assert.deepEqual(read.bytes, FAKE_OGG);
  assert.equal(looked, 0, 'a cache hit never looks for ffmpeg');
  // A voice with no shipped slot (a character added later) is prepared without ffmpeg as the WAV: larger, but it works.
  const other = await player(source, {key: 'panam-palmer'});
  assert.equal(other.format, 'wav'); assert.equal(other.cached, false);
  assert(other.bytes.length > read.bytes.length);
});

test("the Runtime's own slot folder is read after the cache folder, is never written to, and only a slot with the right signature counts", async t => {
  const cache = await mkdtemp(join(tmpdir(), 'voxtral-cache-')), shipped = await mkdtemp(join(tmpdir(), 'voxtral-shipped-'));
  t.after(() => Promise.all([rm(cache, {recursive: true, force: true}), rm(shipped, {recursive: true, force: true})]));
  const source = clip(), changed = clip(11);
  // The Runtime's slot for judy-alvarez, made from `source` (the Pocket clip) the way the release builder makes it.
  await createReferencePreparer({cacheDirectory: shipped, ffmpeg: async () => 'ffmpeg', encode: async () => FAKE_OGG})(source, {key: 'judy-alvarez'});
  const before = await Promise.all((await readdir(shipped)).sort().map(async name => [name, (await readFile(join(shipped, name))).toString('base64')]));
  let encoded = 0;
  const player = (directory = cache, extra = {}) => createReferencePreparer({cacheDirectory: directory, shippedDirectories: [shipped], ffmpeg: async () => null,
    encode: async () => { encoded++; throw Error('must not encode'); }, ...extra});

  // The cache folder has nothing: the Runtime's slot is used, with no ffmpeg and no write.
  const hit = await player()(source, {key: 'judy-alvarez'});
  assert.equal(hit.cached, true); assert.equal(hit.format, 'ogg'); assert.deepEqual(hit.bytes, FAKE_OGG);
  assert.deepEqual(await readdir(cache), [], 'nothing is written when a shipped slot fits');
  // With no cache folder at all, the same.
  assert.deepEqual((await player(null)(source, {key: 'judy-alvarez'})).bytes, FAKE_OGG);

  // A slot in the cache folder that fits wins (the OmniVoice pack's, or one the bridge wrote): it is looked at first.
  const other = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(3000, 9)]);
  await createReferencePreparer({cacheDirectory: cache, ffmpeg: async () => 'ffmpeg', encode: async () => other})(source, {key: 'judy-alvarez'});
  assert.deepEqual((await player()(source, {key: 'judy-alvarez'})).bytes, other);

  // A different clip for the key (the OmniVoice clip, say) does not fit the Runtime's slot: it is prepared again, written to the cache folder only.
  await rm(cache, {recursive: true, force: true});
  const made = await player()(changed, {key: 'judy-alvarez'});
  assert.equal(made.cached, false); assert.equal(made.format, 'wav');
  assert.deepEqual((await readdir(cache)).sort(), ['judy-alvarez.json', 'judy-alvarez.wav']);
  assert.equal(encoded, 0);
  const after = await Promise.all((await readdir(shipped)).sort().map(async name => [name, (await readFile(join(shipped, name))).toString('base64')]));
  assert.deepEqual(after, before, "the Runtime's folder is read-only to the bridge");
  // ...and the next ask for that clip is a hit in the cache folder.
  assert.equal((await player()(changed, {key: 'judy-alvarez'})).cached, true);
  // An unusable shipped folder is ignored, not an error.
  assert.equal((await player(cache, {shippedDirectories: [join(shipped, 'missing')]})(source, {key: 'panam-palmer'})).format, 'wav');
});
