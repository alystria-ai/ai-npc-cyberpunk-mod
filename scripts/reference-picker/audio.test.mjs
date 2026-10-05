import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {concatClips, encodeWav, joinedSeconds, parseWav, resample} from './audio.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = 'E:/CyberpunkConvai-offload/work/reference-picker/pool-index.json';
const PROPOSED = resolve(project, 'runtime/voice-references/multiref-proposed/omni/judy-alvarez.wav');

test('encode/parse round trip keeps 16-bit samples', () => {
  const wav = parseWav(encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1]), 24000));
  assert.equal(wav.rate, 24000);
  assert.equal(wav.frames, 5);
  assert.ok(Math.abs(wav.samples[1] - 0.5) < 1e-4);
});

test('2:1 resampling halves the length and keeps a tone', () => {
  const rate = 48000, input = Float32Array.from({length: 4800}, (_, at) => Math.sin(2 * Math.PI * 440 * at / rate) * 0.5);
  const out = resample(input, rate, 24000);
  assert.equal(out.length, 2400);
  assert.ok(Math.abs(out[1000] - Math.sin(2 * Math.PI * 440 * 2000 / rate) * 0.5) < 0.01);
});

test('clips are joined with 0.4 s of silence', () => {
  const clip = {samples: new Float32Array(48000).fill(0.25), rate: 48000};
  const joined = concatClips([clip, clip]);
  assert.equal(joined.samples.length, 24000 + 9600 + 24000);
  assert.equal(joined.samples[24000 + 100], 0);
  assert.equal(joinedSeconds([1, 1, 1]), 3.8);
});

// The concatenation must match the research agent's proposed reference (torchaudio resample) to about one 16-bit step.
test("matches the research agent's proposed three-clip reference", {skip: !existsSync(PROPOSED) || !existsSync(INDEX)}, () => {
  const index = JSON.parse(readFileSync(INDEX, 'utf8')), voice = index.voices['judy-alvarez'];
  const clips = voice.proposed.omni.clips.map(id => parseWav(readFileSync(resolve(index.dataRoot, voice.clips.find(clip => clip.id === id).p))));
  const mine = parseWav(encodeWav(concatClips(clips).samples, 24000)), theirs = parseWav(readFileSync(PROPOSED));
  assert.equal(mine.frames, theirs.frames);
  let worst = 0;
  for (let at = 0; at < mine.frames; at++) worst = Math.max(worst, Math.abs(mine.samples[at] - theirs.samples[at]));
  assert.ok(worst * 32768 <= 2, `worst difference ${worst * 32768} LSB`);
});
