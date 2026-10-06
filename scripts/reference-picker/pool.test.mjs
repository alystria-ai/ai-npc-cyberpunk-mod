import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool, rerollSet} from './pool.mjs';
import {joinedSeconds} from './audio.mjs';

const clip = (n, d, extra = {}) => ({id: `v/${n}`, d, p: `audio/v/${n}.wav`, t: 'some words in this line', ty: 50, rel: 0, k: null, ...extra});
const seeded = seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

test('reroll: whole clips, at most three, within budget, different from the current set', () => {
  const clips = Array.from({length: 40}, (_, n) => clip(n, 2 + (n % 7)));
  const current = ['v/0', 'v/1', 'v/2'];
  for (const budget of [18, 10]) {
    for (let run = 0; run < 50; run++) {
      const pick = rerollSet(clips, {budget, current, rng: seeded(run + 1)});
      assert.ok(pick.ids.length >= 1 && pick.ids.length <= 3);
      const used = pick.ids.map(id => clips.find(c => c.id === id).d);
      assert.ok(joinedSeconds(used) <= budget + 1e-9, `${joinedSeconds(used)} > ${budget}`);
      assert.ok(pick.ids.every(id => !current.includes(id)));
      assert.equal(new Set(pick.ids).size, pick.ids.length);
    }
  }
});

test('reroll avoids rejected sets, loud outliers and processed clips', () => {
  const clips = [...Array.from({length: 12}, (_, n) => clip(n, 4)), clip(100, 4, {rel: 9}), clip(101, 4, {k: 'phone'})];
  for (let run = 0; run < 60; run++) {
    const pick = rerollSet(clips, {budget: 18, rejected: [['v/0', 'v/1', 'v/2']], rng: seeded(run + 5)});
    assert.ok(!pick.ids.includes('v/100') && !pick.ids.includes('v/101'));
    assert.notDeepEqual([...pick.ids].sort(), ['v/0', 'v/1', 'v/2']);
  }
});

test('reroll copes with tiny pools and returns null when nothing else exists', () => {
  assert.equal(rerollSet([], {budget: 18}), null);
  assert.deepEqual(rerollSet([clip(0, 5)], {budget: 18, rng: seeded(3)}).ids, ['v/0']);
  assert.equal(rerollSet([clip(0, 5)], {budget: 18, current: ['v/0']}), null);
});

test('reroll leaves phone-flagged clips out unless allowPhone, and never falls back to them by default', () => {
  const clips = [...Array.from({length: 10}, (_, n) => clip(n, 4)), ...Array.from({length: 4}, (_, n) => clip(100 + n, 4, {ph: true}))];
  for (let run = 0; run < 60; run++) {
    assert.ok(rerollSet(clips, {budget: 18, rng: seeded(run + 11)}).ids.every(id => !id.startsWith('v/10')));
  }
  const phoneOnly = Array.from({length: 6}, (_, n) => clip(n, 4, {ph: true}));
  assert.equal(rerollSet(phoneOnly, {budget: 18, rng: seeded(2)}), null);
  assert.ok(rerollSet(phoneOnly, {budget: 18, rng: seeded(2), allowPhone: true}).ids.length >= 1);
  // with allowPhone the clean clips are still preferred
  const mixed = [...Array.from({length: 8}, (_, n) => clip(n, 4)), clip(100, 4, {ph: true})];
  for (let run = 0; run < 40; run++) assert.ok(!rerollSet(mixed, {budget: 18, rng: seeded(run + 3), allowPhone: true}).ids.includes('v/100'));
});

test('phone flag: the flags file wins, the dataset delivery kind is the fallback, and the file is re-read when it changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flags-'));
  const flagsPath = join(dir, 'flags.json');
  const live = {omni: {exists: true, d: 5, transcript: 't', reference: 'r.wav', sha256: 'x'}};
  const clips = [clip(0, 4, {k: 'phone'}), clip(1, 4), clip(2, 4, {k: 'phone'}), clip(3, 4, {k: 'media'})];
  const pool = new Pool({dataRoot: '/data', voices: {v: {live, clips, proposed: {}, loudMedian: -20, lines: [{id: 'v/line', t: 'x', d: 2, exists: true}]}}}, {project: dir, flagsPath});
  const ph = () => pool.browse('v').map(item => item.ph);
  assert.deepEqual(ph(), [false, true, false, true, false]);                                   // live omni first, then the clips; no file: kind === 'phone'
  await writeFile(flagsPath, JSON.stringify({schema: 'voice-data-phone-flags/v1', clips: {'v/0': {phone: false}, 'v/1': {phone: true}}, live_references: {omni: {v: {phone: true}}}, evaluation_lines: {'v/line': {phone: true}}}));
  assert.deepEqual(ph(), [true, false, true, true, false]);
  assert.equal(pool.clip('v', 'live:omni').ph, true);
  assert.equal(pool.linePhone({id: 'v/line'}), true);
  assert.equal(pool.rerollClips('v').filter(item => item.ph).length, 2);
  await writeFile(flagsPath, JSON.stringify({clips: {'v/3': {phone: true}}, extra: 'a longer file so the size changes'}));
  assert.deepEqual(ph(), [false, true, false, true, true]);
  await writeFile(flagsPath, 'garbage');
  assert.deepEqual(ph(), [false, true, false, true, false]);
});

test('manual sets are validated against the budget', () => {
  const live = {omni: {exists: true, d: 5, transcript: 't', reference: 'r.wav', sha256: 'x'}};
  const pool = new Pool({dataRoot: '/data', voices: {v: {live, clips: [clip(0, 9), clip(1, 9), clip(2, 2)], proposed: {}, loudMedian: -20}}}, {project: '/p'});
  assert.throws(() => pool.validateSet('v', 'omni', ['v/0', 'v/1']), /18 s/);
  assert.equal(pool.validateSet('v', 'omni', ['v/0', 'v/2']).seconds, 11.4);
  assert.throws(() => pool.validateSet('v', 'omni-short', ['v/0', 'v/2']), /10 s/);
  assert.throws(() => pool.validateSet('v', 'omni', ['v/0', 'v/0']));
  assert.throws(() => pool.validateSet('v', 'omni', ['v/9']), /Unknown clip/);
});
