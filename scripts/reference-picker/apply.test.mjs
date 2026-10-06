import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyPicks, OUTPUTS} from '../Apply-ReferencePicks.mjs';
import {encodeWav, parseWav} from './audio.mjs';
import {Pool} from './pool.mjs';
import {replayPicks} from './picks.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'apply-'));
  await mkdir(join(root, 'data/audio/v'), {recursive: true}); await mkdir(join(root, 'runtime'), {recursive: true});
  const clips = [];
  for (let n = 0; n < 8; n++) {
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

test('three outputs only: Pocket (30 s), OmniVoice long (18 s) and OmniVoice short (10 s)', () => {
  assert.deepEqual(Object.keys(OUTPUTS), ['pocket', 'omni', 'omni-short']);
  assert.deepEqual(Object.values(OUTPUTS).map(spec => spec.maxSeconds), [30, 18, 10]);
  assert.deepEqual(Object.values(OUTPUTS).map(spec => spec.out.split('/').pop()), ['pocket-voices.picked.json', 'local-voices.picked.json', 'local-voices.picked-short.json']);
});

test('any number of whole clips is accepted while the joined seconds fit: Pocket up to 30 s, Omni up to 18 s', async () => {
  const {root, pool} = await project();
  const ids = count => Array.from({length: count}, (_, n) => `v/${n}`);
  const pick = replayPicks([
    {seq: 1, ts: 't', voice: 'v', engine: 'pocket', action: 'keep', clips: ids(8)},                  // 8 x 3 s + 7 gaps = 26.8 s
    {seq: 2, ts: 't', voice: 'v', engine: 'omni', action: 'keep', clips: ids(5)},                    // 5 x 3 s + 4 gaps = 16.6 s
    {seq: 3, ts: 't', voice: 'v', engine: 'omni-short', action: 'keep', clips: ids(3)},              // 3 x 3 s + 2 gaps = 9.8 s
  ]);
  const report = await applyPicks({project: root, pool, pick, validate: false});
  assert.equal(report.engines.pocket.changed[0].seconds, 26.8);
  assert.equal(report.engines.omni.changed[0].seconds, 16.6);
  assert.equal(report.engines['omni-short'].changed[0].seconds, 9.8);
  const short = JSON.parse(await readFile(join(root, 'runtime/local-voices.picked-short.json'), 'utf8'));
  assert.equal(short.voices.v.reference, 'runtime/voice-references/picked/omni-short/v.wav');
  assert.equal(JSON.parse(await readFile(join(root, 'runtime/pocket-voices.picked.json'), 'utf8')).voices.v.pick.clips.length, 8);
});

test('a kept set over its duration limit is refused whatever the clip count', async () => {
  const {root, pool} = await project();
  const ids = Array.from({length: 6}, (_, n) => `v/${n}`);                                         // 6 x 3 s + 5 gaps = 20 s
  await assert.rejects(applyPicks({project: root, pool, validate: false, pick: replayPicks([{seq: 1, ts: 't', voice: 'v', engine: 'omni', action: 'keep', clips: ids}])}), /over its 18 s limit/);
});

test('kept sets of removed engines in an old log are ignored', async () => {
  const {root, pool} = await project();
  const pick = replayPicks([
    {seq: 1, ts: 't', voice: 'v', engine: 'omni-single', action: 'keep', clips: ['v/2']},
    {seq: 2, ts: 't', voice: 'v', engine: 'pocket-single', action: 'keep', clips: ['v/1']},
    {seq: 3, ts: 't', voice: 'v', engine: 'pocket-short', action: 'keep', clips: ['v/3', 'v/1']},
  ]);
  const report = await applyPicks({project: root, pool, pick, validate: false});
  assert.deepEqual(Object.keys(report.engines), ['pocket', 'omni', 'omni-short']);
  assert.ok(Object.values(report.engines).every(entry => entry.output === null));
});
