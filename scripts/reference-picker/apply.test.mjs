import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyPicks} from '../Apply-ReferencePicks.mjs';
import {encodeWav, parseWav} from './audio.mjs';
import {Pool} from './pool.mjs';
import {replayPicks} from './picks.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'apply-'));
  await mkdir(join(root, 'data/audio/v'), {recursive: true}); await mkdir(join(root, 'runtime'), {recursive: true});
  const clips = [];
  for (let n = 0; n < 4; n++) {
    await writeFile(join(root, `data/audio/v/c${n}.wav`), encodeWav(Float32Array.from({length: 48000 * 3}, (_, at) => Math.sin(at / (10 + n)) * 0.3), 48000));
    clips.push({id: `v/${n}`, d: 3, t: `Clip ${n}.`, ty: 50, g: null, k: null, s: 'train', p: `audio/v/c${n}.wav`, lv: -20});
  }
  const entry = (name, text) => ({reference: `runtime/voice-references/${name}.wav`, sha256: 'a'.repeat(64), transcript: text, status: 'ready'});
  const voices = {v: entry('old-v', 'old text'), w: entry('old-w', 'other voice')};
  const base = {version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16, voices};
  await writeFile(join(root, 'runtime/local-voices.json'), JSON.stringify(base));
  await writeFile(join(root, 'runtime/pocket-voices.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', voices}));
  const pool = new Pool({dataRoot: join(root, 'data'), voices: {v: {clips, loudMedian: -20, lines: [], proposed: {}, live: {omni: {exists: false}}},
    w: {clips: [], loudMedian: null, lines: [], proposed: {}, live: {omni: {exists: false}}}}}, {project: root});
  pool.keys = ['v', 'w'];
  return {root, pool};
}

test('writes picked references and configs that replace only the kept voices; live configs are untouched', async () => {
  const {root, pool} = await project();
  const before = {omni: await readFile(join(root, 'runtime/local-voices.json'), 'utf8'), pocket: await readFile(join(root, 'runtime/pocket-voices.json'), 'utf8')};
  const pick = replayPicks([
    {seq: 1, ts: 't', voice: 'v', engine: 'omni', set: 'full', action: 'keep', clips: ['v/2', 'v/0'], seconds: 6.4, note: 'warm'},
    {seq: 2, ts: 't', voice: 'v', engine: 'omni-short', set: 'short', action: 'keep', clips: ['v/1']},
    {seq: 3, ts: 't', voice: 'w', engine: 'pocket', set: 'full', action: 'keep', clips: ['live:omni']},
  ]);
  const report = await applyPicks({project: root, pick, pool, validate: false});
  assert.equal(await readFile(join(root, 'runtime/local-voices.json'), 'utf8'), before.omni);
  assert.equal(await readFile(join(root, 'runtime/pocket-voices.json'), 'utf8'), before.pocket);

  const picked = JSON.parse(await readFile(join(root, 'runtime/local-voices.picked.json'), 'utf8'));
  assert.equal(picked.voices.w.transcript, 'other voice');                      // not kept: unchanged
  const entry = picked.voices.v;
  assert.equal(entry.transcript, 'Clip 2. Clip 0.');                           // joined in the kept order
  assert.equal(entry.reference, 'runtime/voice-references/picked/omni/v.wav');
  const bytes = await readFile(join(root, entry.reference));
  assert.equal(sha(bytes), entry.sha256);
  const wav = parseWav(bytes);
  assert.equal(wav.rate, 24000);
  assert.ok(Math.abs(wav.seconds - 6.4) < 0.001);                              // two 3 s clips plus a 0.4 s gap
  assert.equal(picked.proposal.status, 'PROPOSED - not active');
  assert.deepEqual(picked.proposal.voices_changed, ['v']);
  assert.equal(JSON.parse(await readFile(join(root, 'runtime/local-voices.picked-short.json'), 'utf8')).voices.v.pick.clips[0], 'v/1');
  assert.equal(report.engines.pocket.output, null);                            // "today's reference" kept: nothing to change
  assert.equal(report.skipped.length, 1);
});

test('dry run writes nothing', async () => {
  const {root, pool} = await project();
  const pick = replayPicks([{seq: 1, ts: 't', voice: 'v', engine: 'omni', action: 'keep', clips: ['v/0']}]);
  await applyPicks({project: root, pick, pool, dryRun: true});
  await assert.rejects(readFile(join(root, 'runtime/local-voices.picked.json')));
});

test('a kept set over the Omni limit is refused', async () => {
  const {root, pool} = await project();
  const pick = replayPicks([{seq: 1, ts: 't', voice: 'v', engine: 'omni-short', action: 'keep', clips: ['v/0', 'v/1', 'v/2', 'v/3']}]);
  await assert.rejects(applyPicks({project: root, pick, pool, validate: false}), /over its 10 s limit/);
});
