import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectWav, silentWav, storeSpeech, prepareSpeech, initializeAudioDepot} from './speech-audio.mjs';
import {readdir, writeFile} from 'node:fs/promises';

test('derive duration from PCM frames, not the service sample-rate label', () => {
  assert.deepEqual(inspectWav(silentWav()), {duration: 0.1, sampleRate: 24000, channels: 1, bits: 16});
});
test('reject truncated, compressed, empty and implausibly long speech', () => {
  assert.throws(() => inspectWav(silentWav().subarray(0, 200)));
  for (const [offset, value] of [[20, 6], [22, 0], [34, 8]]) {
    const wav = silentWav(); wav.writeUInt16LE(value, offset); assert.throws(() => inspectWav(wav));
  }
  assert.throws(() => inspectWav(Buffer.from('not audio')));
});
test('invalid audio never replaces an existing valid slot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convai-speech-'));
  try {
    const original = silentWav();
    await storeSpeech(original.toString('base64'), directory, 0);
    await assert.rejects(storeSpeech('broken', directory, 0));
    assert.deepEqual(await readFile(join(directory, 'reply-0.wav')), original);
    await assert.rejects(storeSpeech(original.toString('base64'), directory, 8));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('a prepared speech file is renamed into the slot it is given, and equals what the ordinary store writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convai-speech-'));
  try {
    const audio = silentWav().toString('base64');
    for (const makeupDb of [0, 6]) {
      const prepared = prepareSpeech(audio, directory, {makeupDb});
      const info = await prepared.ready;
      assert.deepEqual(info, {duration: 0.1, sampleRate: 24000, channels: 1, bits: 16});
      assert.ok((await readdir(directory)).some(name => name.startsWith('reply-pre-')), 'written ahead of its slot');
      const stored = await storeSpeech(audio, directory, 3, {makeupDb, prepared});
      assert.deepEqual(stored, {slot: 3, event: 'convai_reply_3', ...info});
      const viaPrepared = await readFile(join(directory, 'reply-3.wav'));
      await storeSpeech(audio, directory, 4, {makeupDb});
      assert.deepEqual(viaPrepared, await readFile(join(directory, 'reply-4.wav')));
      assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('reply-pre-')), [], 'the temporary file became the slot');
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('a prepared file that is discarded, unused for a minute, invalid or taken twice leaves no stray file and still stores the audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convai-speech-'));
  try {
    const audio = silentWav().toString('base64');
    const dropped = prepareSpeech(audio, directory, {makeupDb: 0});
    await dropped.ready; await dropped.discard();
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('reply-pre-')), []);
    // Unused for over a minute: the next preparation removes it.
    let clock = 1_000;
    const forgotten = prepareSpeech(audio, directory, {makeupDb: 0, now: () => clock});
    await forgotten.ready;
    clock += 61_000;
    const next = prepareSpeech(audio, directory, {makeupDb: 0, now: () => clock});
    await next.ready; await forgotten.discard();
    assert.equal((await readdir(directory)).filter(name => name.startsWith('reply-pre-')).length, 1, 'only the new one is left');
    await next.discard();
    // Invalid audio: the preparation fails quietly and the ordinary store reports it.
    const broken = prepareSpeech('broken', directory);
    await assert.rejects(broken.ready);
    await assert.rejects(storeSpeech('broken', directory, 0, {prepared: broken}));
    // The same prepared file cannot be taken by two slots: the second store writes its own copy.
    const once = prepareSpeech(audio, directory, {makeupDb: 0});
    await once.ready;
    await storeSpeech(audio, directory, 1, {makeupDb: 0, prepared: once});
    await storeSpeech(audio, directory, 2, {makeupDb: 0, prepared: once});
    assert.deepEqual(await readFile(join(directory, 'reply-1.wav')), await readFile(join(directory, 'reply-2.wav')));
    // A file lost before the store: the ordinary path takes over.
    const lost = prepareSpeech(audio, directory, {makeupDb: 0});
    await lost.ready; await rm(lost.temp);
    assert.equal((await storeSpeech(audio, directory, 5, {makeupDb: 0, prepared: lost})).slot, 5);
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('reply-pre-')), []);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the depot start-up removes prepared files a bridge left behind', async () => {
  const game = await mkdtemp(join(tmpdir(), 'convai-game-'));
  try {
    const depot = join(game, 'r6/audioware/CyberpunkConvai');
    await (await import('node:fs/promises')).mkdir(depot, {recursive: true});
    await writeFile(join(depot, 'reply-pre-123e4567-e89b-12d3-a456-426614174000.tmp'), 'x');
    await writeFile(join(depot, 'reply-0.wav.tmp'), 'keep');
    await initializeAudioDepot(game);
    const names = await readdir(depot);
    assert.equal(names.some(name => name.startsWith('reply-pre-')), false);
    assert.ok(names.includes('reply-0.wav.tmp'));
  } finally { await rm(game, {recursive: true, force: true}); }
});
