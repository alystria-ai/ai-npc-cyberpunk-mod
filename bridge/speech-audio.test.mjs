import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectWav, silentWav, storeSpeech} from './speech-audio.mjs';

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
