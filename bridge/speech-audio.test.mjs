import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectWav, readPcmWav, silentWav, removeAudioDepot, audioReady} from './speech-audio.mjs';

// A PCM or float WAV with the given format and frame count (silence).
function wav({codec = 1, channels = 1, rate = 24000, bits = 16, frames = 2400} = {}) {
  const align = channels * bits / 8, size = frames * align, bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(codec, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * align, 28);
  bytes.writeUInt16LE(align, 32); bytes.writeUInt16LE(bits, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(size, 40);
  return bytes;
}

test('derive duration from PCM frames, not the service sample-rate label', () => {
  assert.deepEqual(inspectWav(silentWav()), {duration: 0.1, sampleRate: 24000, channels: 1, bits: 16});
  // The header's byte rate is never read: only the frame count and the sample rate decide the duration.
  const lying = silentWav(); lying.writeUInt32LE(96000, 28);
  assert.equal(inspectWav(lying).duration, 0.1);
});

test('reject truncated, compressed, empty and implausibly long speech', () => {
  assert.throws(() => inspectWav(silentWav().subarray(0, 200)));
  for (const [offset, value] of [[20, 6], [22, 0], [34, 8]]) {
    const bad = silentWav(); bad.writeUInt16LE(value, offset); assert.throws(() => inspectWav(bad));
  }
  assert.throws(() => inspectWav(Buffer.from('not audio')));
  assert.throws(() => inspectWav('AAAA'), /supported WAV/, 'only a Buffer is read');
  assert.throws(() => inspectWav(Buffer.alloc(0)));
  assert.throws(() => inspectWav(wav({frames: 0})), /duration/);
});

test('a chunk that claims more bytes than the file has is a truncated WAV', () => {
  const bytes = silentWav(); bytes.writeUInt32LE(9600, 40);
  assert.throws(() => readPcmWav(bytes), /Truncated/);
  const cut = silentWav().subarray(0, 44 + 2000);
  assert.throws(() => readPcmWav(cut), /Truncated/);
});

test('the supported formats read, and everything else is refused with the format error', () => {
  for (const options of [{bits: 16}, {bits: 24}, {bits: 32}, {codec: 3, bits: 32}, {channels: 2}, {rate: 8000}, {rate: 96000}, {rate: 48000, channels: 2, bits: 24}]) {
    const read = readPcmWav(wav({frames: 9600, ...options}));
    assert.equal(read.sampleRate, options.rate ?? 24000); assert.equal(read.channels, options.channels ?? 1);
    assert.equal(read.bits, options.bits ?? 16); assert.equal(read.align, read.channels * read.bits / 8);
  }
  for (const options of [{channels: 3}, {rate: 7999}, {rate: 96001}, {bits: 8}, {codec: 3, bits: 16}, {codec: 2}]) {
    assert.throws(() => readPcmWav(wav({frames: 4800, ...options})), /Unsupported speech WAV format/, JSON.stringify(options));
  }
  const noData = silentWav().subarray(0, 36); noData.writeUInt32LE(28, 4);
  assert.throws(() => readPcmWav(noData), /supported WAV|Unsupported/, 'a file with no data chunk');
  const misaligned = silentWav(); misaligned.writeUInt16LE(3, 32);
  assert.throws(() => readPcmWav(misaligned), /Unsupported speech WAV format/, 'block align must be channels x bytes');
  const notWave = silentWav(); notWave.write('AVI ', 8);
  assert.throws(() => readPcmWav(notWave), /supported WAV/);
});

test('speech shorter than 50 ms or longer than two minutes is outside the supported range', () => {
  assert.throws(() => readPcmWav(wav({frames: 1000})), /duration/);
  assert.equal(readPcmWav(wav({frames: 1200})).duration, 0.05);
  // 119 s of 8 kHz 16-bit mono is fine (about 1.9 MB), 121 s is not.
  assert.ok(readPcmWav(wav({rate: 8000, frames: 8000 * 119})).duration <= 120);
  assert.throws(() => readPcmWav(wav({rate: 8000, frames: 8000 * 121})), /duration/);
  // A file over 24 MB is never read at all.
  assert.throws(() => readPcmWav(Buffer.alloc(24000001)), /supported WAV/);
});

test('a chunk is padded to an even size, and the data after an odd chunk is still found', () => {
  const base = silentWav(), junk = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from([1, 2, 3, 0])]);
  const bytes = Buffer.concat([base.subarray(0, 36), junk, base.subarray(36)]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  assert.deepEqual(inspectWav(bytes), {duration: 0.1, sampleRate: 24000, channels: 1, bits: 16});
});

const DEPOT = 'r6/audioware/CyberpunkConvai';
async function makeGame() {
  const game = await mkdtemp(join(tmpdir(), 'convai-game-'));
  await mkdir(join(game, DEPOT), {recursive: true});
  return game;
}
const PRE = 'reply-pre-123e4567-e89b-12d3-a456-426614174000.tmp';

test('removeAudioDepot removes exactly the files older versions wrote, the folder when it is then empty, and reports how many', async () => {
  const game = await makeGame();
  try {
    const depot = join(game, DEPOT);
    const names = ['speech.yml', PRE, ...[0, 1, 7].flatMap(n => [`reply-${n}.wav`, `reply-${n}.wav.tmp`])];
    for (const name of names) await writeFile(join(depot, name), 'x');
    assert.equal(await removeAudioDepot(game), names.length);
    await assert.rejects(readdir(depot), /ENOENT/, 'the empty folder is removed with them');
    assert.deepEqual(await readdir(join(game, 'r6/audioware')), []);
  } finally { await rm(game, {recursive: true, force: true}); }
});

test('removeAudioDepot leaves every other file in that folder, and then the folder too', async () => {
  const game = await makeGame();
  try {
    const depot = join(game, DEPOT);
    const keep = ['reply-8.wav', 'reply-10.wav', 'reply-0.wav.bak', 'reply-pre-short.tmp', 'reply-pre-123e4567-e89b-12d3-a456-426614174000.wav',
      'speech.yml.bak', 'speech.yaml', 'notes.txt', 'my-voice.wav'];
    for (const name of [...keep, 'speech.yml', 'reply-3.wav', PRE]) await writeFile(join(depot, name), 'x');
    assert.equal(await removeAudioDepot(game), 3);
    assert.deepEqual((await readdir(depot)).sort(), [...keep].sort());
  } finally { await rm(game, {recursive: true, force: true}); }
});

test('removeAudioDepot never touches another mod under r6/audioware, and returns 0 when the folder is missing', async () => {
  const game = await makeGame();
  try {
    const other = join(game, 'r6/audioware/other-mod');
    await mkdir(other, {recursive: true});
    for (const name of ['speech.yml', 'reply-0.wav', PRE]) await writeFile(join(other, name), 'x');
    await mkdir(join(game, 'r6/audioware/CyberpunkConvaiExtra'), {recursive: true});
    await writeFile(join(game, 'r6/audioware/CyberpunkConvaiExtra/reply-0.wav'), 'x');
    await writeFile(join(game, DEPOT, 'reply-0.wav'), 'x');
    assert.equal(await removeAudioDepot(game), 1);
    assert.deepEqual((await readdir(other)).sort(), [PRE, 'reply-0.wav', 'speech.yml'].sort());
    assert.deepEqual(await readdir(join(game, 'r6/audioware/CyberpunkConvaiExtra')), ['reply-0.wav']);
    assert.equal(await removeAudioDepot(game), 0, 'a second run finds nothing');
    assert.equal(await removeAudioDepot(join(game, 'no-such-game')), 0);
  } finally { await rm(game, {recursive: true, force: true}); }
});

test('removeAudioDepot does not remove a sub-folder that happens to carry a depot file name', async () => {
  const game = await makeGame();
  try {
    await mkdir(join(game, DEPOT, 'reply-2.wav'), {recursive: true});
    await writeFile(join(game, DEPOT, 'reply-2.wav/inner.txt'), 'x');
    assert.equal(await removeAudioDepot(game), 0);
    assert.deepEqual(await readdir(join(game, DEPOT)), ['reply-2.wav']);
  } finally { await rm(game, {recursive: true, force: true}); }
});

test('the speech adapter counts as ready only while its state is fresh and says available', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'convai-runtime-'));
  try {
    assert.equal(await audioReady(runtime), false, 'no state file');
    const write = value => writeFile(join(runtime, 'speech-state.json'), JSON.stringify(value));
    await write({available: true, updated: Date.now()}); assert.equal(await audioReady(runtime), true);
    await write({available: true, updated: Date.now() - 6000}); assert.equal(await audioReady(runtime), false);
    await write({available: false, updated: Date.now()}); assert.equal(await audioReady(runtime), false);
    await writeFile(join(runtime, 'speech-state.json'), '{broken'); assert.equal(await audioReady(runtime), false);
  } finally { await rm(runtime, {recursive: true, force: true}); }
});

test('a voice turn that is running tolerates a stalled game: the heartbeat may be older when the caller says so, and a torn read is read again', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'convai-runtime-'));
  try {
    const path = join(runtime, 'speech-state.json');
    await writeFile(path, JSON.stringify({available: true, updated: Date.now() - 17000}));
    assert.equal(await audioReady(runtime), false, 'the ordinary lease is 5 s');
    assert.equal(await audioReady(runtime, 30000), true, 'a running recording keeps going through a 17 s stall of the game');
    assert.equal(await audioReady(runtime, 10000), false);
    // CET rewrites the file in place: a read that lands between the truncate and the write sees nothing, and 15 ms later the whole file.
    await writeFile(path, '');
    setTimeout(() => { void writeFile(path, JSON.stringify({available: true, updated: Date.now()})); }, 5);
    assert.equal(await audioReady(runtime), true, 'an empty or half-written read is repeated once');
  } finally { await rm(runtime, {recursive: true, force: true}); }
});
