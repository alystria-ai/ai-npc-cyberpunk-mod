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
  const clips = [...Array.from({length: 12}, (_, n) => clip(n, 4)), clip(100, 4, {rel: 9}), clip(101, 4, {k: 'media'})];
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

test('reroll treats phone-processed clips like any other and still avoids media-processed ones', () => {
  const phoneOnly = Array.from({length: 6}, (_, n) => clip(n, 4, {k: 'phone'}));
  assert.ok(rerollSet(phoneOnly, {budget: 18, rng: seeded(2)}).ids.length >= 1);
  const mixed = [...Array.from({length: 8}, (_, n) => clip(n, 4)), clip(100, 4, {k: 'media'})];
  for (let run = 0; run < 40; run++) assert.ok(!rerollSet(mixed, {budget: 18, rng: seeded(run + 3)}).ids.includes('v/100'));
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

test('expanded clips keep an absolute path (the game-archive pool lives outside the dataset root) and show up in browse with their source', () => {
  const absolute = join(tmpdir(), 'expanded', 'v', '123.wav');
  const pool = new Pool({dataRoot: '/data', voices: {v: {live: {omni: {exists: false}}, clips: [clip(0, 4), clip(1, 5, {id: 'v/123', p: absolute, s: 'expanded', src: 'game archive'})], proposed: {}, loudMedian: -20}}}, {project: '/p'});
  assert.equal(pool.clip('v', 'v/123').path, absolute);
  assert.ok(pool.clip('v', 'v/0').path.split('\\').join('/').endsWith('/data/audio/v/0.wav'));
  const browse = pool.browse('v');
  assert.deepEqual(browse.map(item => [item.id, item.s]), [['v/0', undefined], ['v/123', 'expanded']]);
  assert.equal(pool.seconds('v', ['v/0', 'v/123']), 9.4);
});

test('clips flagged as effect-heavy (fx) stay resolvable but are left out of browse, reroll and the pool size', () => {
  const clips = [...Array.from({length: 10}, (_, n) => clip(n, 4)), clip(50, 4, {fx: ['comb']}), clip(51, 4, {fx: ['band-limited']})];
  const pool = new Pool({dataRoot: '/data', voices: {v: {live: {omni: {exists: false}}, clips, proposed: {}, loudMedian: -20}}}, {project: '/p'});
  assert.ok(pool.clip('v', 'v/50'));                                             // an existing starting set can still use it
  assert.ok(!pool.browse('v').some(item => item.id === 'v/50' || item.id === 'v/51'));
  assert.equal(pool.usableCount('v'), 10);
  for (let run = 0; run < 40; run++) assert.ok(rerollSet(pool.rerollClips('v'), {budget: 18, rng: seeded(run + 1)}).ids.every(id => id !== 'v/50' && id !== 'v/51'));
});
