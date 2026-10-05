import test from 'node:test';
import assert from 'node:assert/strict';
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

test('manual sets are validated against the budget', () => {
  const live = {omni: {exists: true, d: 5, transcript: 't', reference: 'r.wav', sha256: 'x'}};
  const pool = new Pool({dataRoot: '/data', voices: {v: {live, clips: [clip(0, 9), clip(1, 9), clip(2, 2)], proposed: {}, loudMedian: -20}}}, {project: '/p'});
  assert.throws(() => pool.validateSet('v', 'full', ['v/0', 'v/1']), /18 s/);
  assert.equal(pool.validateSet('v', 'full', ['v/0', 'v/2']).seconds, 11.4);
  assert.throws(() => pool.validateSet('v', 'short', ['v/0', 'v/2']), /10 s/);
  assert.throws(() => pool.validateSet('v', 'full', ['v/0', 'v/0']));
  assert.throws(() => pool.validateSet('v', 'full', ['v/9']), /Unknown clip/);
});
