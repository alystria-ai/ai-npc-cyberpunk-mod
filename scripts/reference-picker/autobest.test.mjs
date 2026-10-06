import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AUTOBEST_OUTPUTS, buildAutobest, picksFromAutobest} from '../Build-AutobestConfigs.mjs';
import {encodeWav, parseWav} from './audio.mjs';
import {Pool} from './pool.mjs';

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'autobest-'));
  await mkdir(join(root, 'data/audio/v'), {recursive: true}); await mkdir(join(root, 'runtime'), {recursive: true});
  const clips = [];
  for (let n = 0; n < 4; n++) {
    await writeFile(join(root, `data/audio/v/c${n}.wav`), encodeWav(Float32Array.from({length: 48000 * 3}, (_, at) => Math.sin(at / (10 + n)) * 0.3), 48000));
    clips.push({id: `v/${n}`, d: 3, t: `Clip ${n}.`, ty: 50, g: null, k: null, s: 'train', p: `audio/v/c${n}.wav`, lv: -20});
  }
  const entry = (name, text) => ({reference: `runtime/voice-references/${name}.wav`, sha256: 'a'.repeat(64), transcript: text, status: 'ready'});
  const voices = {v: entry('old-v', 'old text'), w: entry('old-w', 'other voice')};
  await writeFile(join(root, 'runtime/local-voices.json'), JSON.stringify({version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16, voices}));
  await writeFile(join(root, 'runtime/pocket-voices.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', voices}));
  const pool = new Pool({dataRoot: join(root, 'data'), voices: {v: {clips, loudMedian: -20, lines: [], proposed: {}, live: {omni: {exists: false}}},
    w: {clips: [], loudMedian: null, lines: [], proposed: {}, live: {omni: {exists: false}}}}}, {project: root});
  pool.keys = ['v', 'w'];
  return {root, pool};
}

const set = (ids, seconds) => ({ids, k: ids.length, seconds, ecapa: 0.7, ecapa_se: 0.01, pls: 88});
const data = {generated: '2026-10-07T00:00:00Z', voices: {
  v: {omni: {best: set(['v/2', 'v/0', 'v/1'], 9.8), short: set(['v/3', 'v/1'], 6.4), single: set(['v/3'], 3)},
    pocket: {best: set(['v/0', 'v/3'], 6.4), short: set(['v/0', 'v/3'], 6.4), single: set(['live:pocket'], 5)}},
  w: {omni: {best: set(['live:omni'], 5)}}}};

test('the searched winners become kept sets per engine variant; today\'s reference is skipped', () => {
  const picks = picksFromAutobest(data);
  assert.deepEqual(Object.keys(picks.voices.v.kept).sort(), ['omni', 'omni-short', 'omni-single', 'pocket', 'pocket-short']);
  assert.deepEqual(picks.voices.v.kept.omni.clips, ['v/2', 'v/0', 'v/1']);
  assert.equal(picks.voices.w, undefined);
  assert.deepEqual(Object.keys(picksFromAutobest(data, {only: ['w']}).voices), []);
});

test('writes .autobest configs and references; the live configs are untouched', async () => {
  const {root, pool} = await project();
  const before = {omni: await readFile(join(root, 'runtime/local-voices.json'), 'utf8'), pocket: await readFile(join(root, 'runtime/pocket-voices.json'), 'utf8')};
  const report = await buildAutobest({project: root, data, pool, validate: false});
  assert.equal(await readFile(join(root, 'runtime/local-voices.json'), 'utf8'), before.omni);
  assert.equal(await readFile(join(root, 'runtime/pocket-voices.json'), 'utf8'), before.pocket);
  const omni = JSON.parse(await readFile(join(root, AUTOBEST_OUTPUTS.omni.out), 'utf8'));
  assert.equal(omni.voices.w.transcript, 'other voice');
  assert.equal(omni.voices.v.transcript, 'Clip 2. Clip 0. Clip 1.');
  assert.equal(omni.voices.v.reference, 'runtime/voice-references/picked/autobest/omni/v.wav');
  const wav = parseWav(await readFile(join(root, omni.voices.v.reference)));
  assert.ok(Math.abs(wav.seconds - 9.8) < 0.001);                      // three 3 s clips plus two 0.4 s gaps
  assert.equal(omni.proposal.source, 'clip search (Build-AutobestConfigs.mjs)');
  const short = JSON.parse(await readFile(join(root, AUTOBEST_OUTPUTS['omni-short'].out), 'utf8'));
  assert.deepEqual(short.voices.v.pick.clips, ['v/3', 'v/1']);
  assert.equal(report.engines['pocket-single'].output, null);          // the single-clip winner was today's reference
  assert.ok(JSON.parse(await readFile(join(root, AUTOBEST_OUTPUTS.pocket.out), 'utf8')).voices.v.pick.note.includes('ECAPA 0.7'));
});

test('a set over its length cap is refused', async () => {
  const {root, pool} = await project();
  const bad = {voices: {v: {omni: {short: set(['v/0', 'v/1', 'v/2', 'v/3'], 13.2)}}}};
  await assert.rejects(buildAutobest({project: root, data: bad, pool, validate: false}), /over its 10 s limit/);
});

test('the picker offers only auto-best sets its pool can load', async () => {
  const {Autobest} = await import('./autobest.mjs');
  const {root, pool} = await project();
  await writeFile(join(root, 'runtime/autobest-sets.json'), JSON.stringify({generated: 'g', engines: {omni: {tag: 'omni16'}}, voices: {v: {
    omni: {best: set(['v/2', 'v/0', 'v/1'], 9.8), short: set(['v/0', 'v/1', 'v/2', 'v/3'], 13.2), single: set(['v/9'], 3), today: {ecapa: 0.6}},
    pocket: {best: set(['live:pocket'], 5)}}}}));
  const offered = await new Autobest({project: root}).forVoice('v', pool);
  assert.deepEqual(Object.keys(offered), ['omni']);                      // too long, unknown clip and today's reference are dropped
  assert.deepEqual(offered.omni.ids, ['v/2', 'v/0', 'v/1']);
  assert.equal(offered.omni.today, 0.6);
  assert.deepEqual(await new Autobest({project: root, file: join(root, 'missing.json')}).forVoice('v', pool), {});
});
