import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AUTOBEST_OUTPUTS, buildAutobest, picksFromAutobest} from '../Build-AutobestConfigs.mjs';
import {Autobest} from './autobest.mjs';
import {encodeWav, parseWav} from './audio.mjs';
import {Pool} from './pool.mjs';

// Schema version 2 of runtime/autobest-sets.json (written by scripts/clip-search/collect.py): winners by total DURATION.
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'autobest-'));
  await mkdir(join(root, 'data/audio/v'), {recursive: true}); await mkdir(join(root, 'runtime'), {recursive: true});
  const clips = [];
  for (let n = 0; n < 8; n++) {
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

const set = (ids, seconds, extra = {}) => ({ids, seconds, ecapa: 0.7, ecapa_se: 0.01, pls: 88, ...extra});
const latency = {latency_ms: {16: 240, 32: 540}};
const today = {ids: ['live:omni'], seconds: 5, ecapa: 0.6, pls: 80};
const data = {version: 2, generated: '2026-10-07T00:00:00Z', engines: {omni: {tag: 'omni16'}, pocket: {tag: 'pocket-test'}}, voices: {
  v: {omni: {short: set(['v/3', 'v/1'], 6.4, latency), long: set(['v/2', 'v/0', 'v/1', 'v/3', 'v/4'], 16.6, latency), best: set(['v/2', 'v/0', 'v/1'], 9.8, latency), today,
      curve: [{seconds: 3.1, ecapa: 0.6, ecapa_se: 0.02}, {seconds: 9.8, ecapa: 0.7, ecapa_se: 0.01}]},
    pocket: {best: set(['v/0', 'v/3', 'v/4', 'v/5', 'v/6', 'v/7', 'v/1', 'v/2'], 26.8), today, curve: []}},
  w: {omni: {best: set(['live:omni'], 5), short: set(['live:omni'], 5)}}}};

test('the output names, folders and limits: Pocket 30 s, Omni best 18 s, short 10 s, long 18 s; nothing per clip count', () => {
  assert.deepEqual(Object.keys(AUTOBEST_OUTPUTS), ['pocket', 'omni', 'omni-short', 'omni-long']);
  assert.deepEqual(Object.values(AUTOBEST_OUTPUTS).map(spec => spec.out),
    ['runtime/pocket-voices.autobest.json', 'runtime/local-voices.autobest.json', 'runtime/local-voices.autobest-short.json', 'runtime/local-voices.autobest-long.json']);
  assert.deepEqual(Object.values(AUTOBEST_OUTPUTS).map(spec => spec.maxSeconds), [30, 18, 10, 18]);
  assert.deepEqual(Object.values(AUTOBEST_OUTPUTS).map(spec => spec.folder), ['autobest/pocket', 'autobest/omni', 'autobest/omni-short', 'autobest/omni-long']);
});

test('pocket.best, omni.best, omni.short and omni.long become kept sets; today\'s reference is skipped', () => {
  const picks = picksFromAutobest(data);
  assert.deepEqual(Object.keys(picks.voices.v.kept).sort(), ['omni', 'omni-long', 'omni-short', 'pocket']);
  assert.deepEqual(picks.voices.v.kept.omni.clips, ['v/2', 'v/0', 'v/1']);
  assert.deepEqual(picks.voices.v.kept['omni-long'].clips, ['v/2', 'v/0', 'v/1', 'v/3', 'v/4']);
  assert.equal(picks.voices.w, undefined);
  assert.equal(picks.entries, 4);
  assert.deepEqual(Object.keys(picksFromAutobest(data, {only: ['w']}).voices), []);
});

test('writes the four .autobest configs and references; the live configs are untouched', async () => {
  const {root, pool} = await project();
  const before = {omni: await readFile(join(root, 'runtime/local-voices.json'), 'utf8'), pocket: await readFile(join(root, 'runtime/pocket-voices.json'), 'utf8')};
  const report = await buildAutobest({project: root, data, pool, validate: false});
  assert.equal(await readFile(join(root, 'runtime/local-voices.json'), 'utf8'), before.omni);
  assert.equal(await readFile(join(root, 'runtime/pocket-voices.json'), 'utf8'), before.pocket);
  const read = async name => JSON.parse(await readFile(join(root, AUTOBEST_OUTPUTS[name].out), 'utf8'));
  const omni = await read('omni');                                     // omni.best -> local-voices.autobest.json
  assert.equal(omni.voices.w.transcript, 'other voice');
  assert.equal(omni.voices.v.transcript, 'Clip 2. Clip 0. Clip 1.');
  assert.equal(omni.voices.v.reference, 'runtime/voice-references/picked/autobest/omni/v.wav');
  const wav = parseWav(await readFile(join(root, omni.voices.v.reference)));
  assert.ok(Math.abs(wav.seconds - 9.8) < 0.001);                      // three 3 s clips plus two 0.4 s gaps
  assert.equal(omni.proposal.source, 'clip search (Build-AutobestConfigs.mjs)');
  assert.deepEqual((await read('omni-short')).voices.v.pick.clips, ['v/3', 'v/1']);
  const long = await read('omni-long');                                // five clips: the count does not matter, 16.6 s does
  assert.deepEqual(long.voices.v.pick.clips, ['v/2', 'v/0', 'v/1', 'v/3', 'v/4']);
  assert.equal(long.voices.v.reference, 'runtime/voice-references/picked/autobest/omni-long/v.wav');
  assert.equal(report.engines['omni-long'].changed[0].seconds, 16.6);
  const pocket = await read('pocket');                                 // eight clips, 26.8 s, under Pocket's 30 s
  assert.equal(pocket.voices.v.pick.clips.length, 8);
  assert.ok(pocket.voices.v.pick.note.includes('ECAPA 0.7'));
  assert.equal(report.engines.pocket.changed[0].seconds, 26.8);
});

test('a set over its duration cap is refused', async () => {
  const {root, pool} = await project();
  const bad = {voices: {v: {omni: {short: set(['v/0', 'v/1', 'v/2', 'v/3'], 13.2)}}}};
  await assert.rejects(buildAutobest({project: root, data: bad, pool, validate: false}), /over its 10 s limit/);
});

test('the picker offers pocket <- pocket.best, omni-short <- omni.short, omni <- omni.long, only when the pool can load them', async () => {
  const {root, pool} = await project();
  await writeFile(join(root, 'runtime/autobest-sets.json'), JSON.stringify(data));
  const offered = await new Autobest({project: root}).forVoice('v', pool);
  assert.deepEqual(Object.keys(offered).sort(), ['omni', 'omni-short', 'pocket']);
  assert.deepEqual(offered.omni.ids, ['v/2', 'v/0', 'v/1', 'v/3', 'v/4']);           // omni.long, not omni.best
  assert.deepEqual(offered['omni-short'].ids, ['v/3', 'v/1']);
  assert.equal(offered.pocket.ids.length, 8);
  assert.deepEqual(offered.omni, {ids: offered.omni.ids, seconds: 16.6, ecapa: 0.7, ecapaSe: 0.01, pls: 88, today: 0.6, latencyMs: {16: 240, 32: 540}, engine: 'omni16', generated: '2026-10-07T00:00:00Z'});
  assert.equal(offered.pocket.engine, 'pocket-test');
  assert.equal(offered.pocket.latencyMs, null);
  assert.equal(offered.pocket.today, 0.6);
  assert.deepEqual(await new Autobest({project: root}).forVoice('w', pool), {});     // today's reference won: nothing to load
  assert.deepEqual(await new Autobest({project: root, file: join(root, 'missing.json')}).forVoice('v', pool), {});
});

test('sets that are too long for their budget, hold an unknown clip or are today\'s reference are not offered', async () => {
  const {root, pool} = await project();
  await writeFile(join(root, 'runtime/autobest-sets.json'), JSON.stringify({version: 2, voices: {v: {
    omni: {short: set(['v/0', 'v/1', 'v/2', 'v/3'], 13.2), long: set(['v/9'], 3), best: set(['v/0'], 3)},
    pocket: {best: set(['live:pocket'], 5)}}}}));
  assert.deepEqual(await new Autobest({project: root}).forVoice('v', pool), {});
  await writeFile(join(root, 'runtime/autobest-sets.json'), JSON.stringify({version: 2, voices: {v: {omni: {
    long: set(['v/0', 'v/1', 'v/2', 'v/3', 'v/4', 'v/5'], 20)}}}}));                  // six clips, 20 s: over the 18 s long budget
  assert.deepEqual(await new Autobest({project: root}).forVoice('v', pool), {});
});
