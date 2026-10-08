import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SPEECH_TRACKS} from './facial-timeline.mjs';
import {EXPRESSION_TRACKS, EXPRESSION_POLICY, normalizeConvaiEmotion,
  sameExpressionOwner, OwnedExpressionSignal, expressionTarget,
  emotionSuppressesSmile, ExpressionSmoother, composeExpressionPose, mixTarget} from './companion-expressions.mjs';

const owner = {entity: 'copy-a', requestId: 'reply-a', generation: 1};
const corners = pose => [pose.lips_l_corner_up, pose.lips_r_corner_up];
const provider = indices => ({format: 'arkit61', values: Array.from({length: 61}, (_, i) => indices[i] || 0)});

test('expression ownership is disjoint from accepted speech and native blink/gaze', () => {
  const schema = JSON.parse(readFileSync(new URL('../assets/facial/controls.json', import.meta.url), 'utf8'));
  assert.equal(EXPRESSION_TRACKS.length, new Set(EXPRESSION_TRACKS).size);
  for (const track of EXPRESSION_TRACKS) {
    assert.ok(schema.tracks.includes(track), `${track} must exist in the current native graph`);
    assert.ok(!SPEECH_TRACKS.includes(track), `${track} must not replace accepted articulation`);
    // The outer-eye squint (Duchenne smile) is expression; blink, widen and gaze stay native.
    assert.doesNotMatch(track, /blink|widen|tongue|jaw|look|rotate|yaw|pitch|roll/iu);
    if (/squint/.test(track)) assert.match(track, /^eye_[lr]_oculi_squint_outer_lower$/);
  }
});

test('SDK intensity is categorical 1..3; missing intensity is conservatively low', () => {
  assert.deepEqual(normalizeConvaiEmotion({emotion: ' Grief ', scale: 2}),
    {version: 1, emotion: 'Grief', family: 'sadness', scale: 2});
  assert.equal(normalizeConvaiEmotion({emotion: 'Trust'}).scale, 1);
  for (const scale of [0, .5, 4, Infinity, NaN, '2', true, null])
    assert.equal(normalizeConvaiEmotion({emotion: 'Joy', scale}), null);
  for (const value of [null, [], 'Joy', {emotion: ''}, {emotion: 'x'.repeat(81)},
    {emotion: 'Joy\nAnger'}, {data: {emotion: 'Joy', scale: 1}}])
    assert.equal(normalizeConvaiEmotion(value), null);
});

test('unknown provider labels preserve data distinction and never imply joy', () => {
  const unknown = {emotion: 'A newly introduced provider mood', scale: 3};
  assert.equal(normalizeConvaiEmotion(unknown).family, 'unknown');
  assert.ok(emotionSuppressesSmile(unknown));
  assert.deepEqual(corners(expressionTarget({emotion: unknown})), [0, 0]);
});

test('calm idle and speech with no intent rest neutral (October 8); processing has nothing either', () => {
  const idle = expressionTarget();
  // The resting smile (.10-.22) made Judy smile through sad conversations; a smile now needs a real cue.
  assert.equal(EXPRESSION_POLICY.restSmile, 0);
  assert.deepEqual(corners(idle), [0, 0]);
  const speaking = expressionTarget({phase: 'speaking'});
  assert.deepEqual(corners(speaking), [0, 0]);
  // A caller can still pass an explicit warmth (the floor logic is unchanged).
  assert.ok(expressionTarget({warmth: .15}).lips_l_corner_up > 0);
  for (const phase of ['listening', 'thinking'])
    assert.deepEqual(corners(expressionTarget({phase})), [0, 0]);
  assert.ok(Object.values(expressionTarget({blocked: true})).every(value => value === 0));
});

for (const label of ['Anger', 'Rage', 'Grief', 'Sadness', 'Fear', 'Disgust']) {
  test(`${label} suppresses the default/previous smile and has a bounded appropriate target`, () => {
    const emotion = {emotion: label, scale: 3};
    const target = expressionTarget({emotion, providerFrame: provider({23: 1, 24: 1})});
    assert.deepEqual(corners(target), [0, 0]);
    assert.ok(emotionSuppressesSmile(emotion));
    assert.ok(Object.values(target).some(value => value > 0));
    assert.ok(Object.values(target).every(value => value >= 0 && value <= .55), 'within the caps');
    const smoother = new ExpressionSmoother();
    smoother.update(expressionTarget({emotion: {emotion: 'Joy', scale: 3}}), .1);
    const result = smoother.update(target, 1 / 60, {suppressSmile: emotionSuppressesSmile(emotion)});
    assert.deepEqual(corners(result), [0, 0], 'A decaying smile must not persist through negative intent');
  });
}

test('emotions are visible: peaks follow the live face-test (smile reads at .35-.5, 1.0 is a grin)', () => {
  const peak = (emotion, scale) => expressionTarget({emotion: {emotion, scale}});
  const near = (value, wanted) => assert.ok(Math.abs(value - wanted) < .01, value + ' vs ' + wanted);
  near(peak('Joy', 3).lips_l_corner_up, .45); near(peak('Joy', 2).lips_l_corner_up, .30);
  assert.ok(peak('Joy', 1).lips_l_corner_up < peak('Joy', 2).lips_l_corner_up);
  near(peak('Trust', 3).lips_l_corner_up, .25);
  near(peak('Sadness', 3).lips_l_corner_dn, .40); near(peak('Sadness', 3).eye_l_brows_raise_in, .45);
  near(peak('Anger', 3).eye_l_brows_lower, .45); near(peak('Anger', 3).lips_l_corner_dn, .25);
  near(peak('Surprise', 3).eye_l_brows_raise_out, .50);
  assert.ok(peak('Interest', 2).eye_l_brows_raise_out >= .09 && peak('Interest', 2).eye_l_brows_raise_out <= .11, 'Interest is a brief flick, not a raise');
  // Caps: corners .5, brows .55; nothing exceeds them, and no pose is a grin (1.0).
  for (const name of ['Joy', 'Trust', 'Sadness', 'Anger', 'Fear', 'Disgust', 'Surprise', 'Interest'])
    for (const [track, value] of Object.entries(peak(name, 3)))
      assert.ok(value <= (track.startsWith('lips_') ? .50 : .55), name + ' ' + track);
  assert.equal(EXPRESSION_POLICY.cornerUpMax, .5); assert.equal(EXPRESSION_POLICY.browRaiseMax, .55);
  // Warm default (Trust scale 2) is about .15-.17 and survives speech at 85 %.
  const warm = expressionTarget({emotion: {emotion: 'Trust', scale: 2}, phase: 'speaking'}).lips_l_corner_up;
  assert.ok(warm >= .13 && warm <= .17, String(warm));
});

test('positive intensity progresses gently without opening the jaw', () => {
  const values = [1, 2, 3].map(scale => expressionTarget({emotion: {emotion: 'Joy', scale}}));
  assert.ok(values[0].lips_l_corner_up < values[1].lips_l_corner_up);
  assert.ok(values[1].lips_l_corner_up < values[2].lips_l_corner_up);
  assert.ok(values[2].lips_l_corner_up <= EXPRESSION_POLICY.cornerUpMax);
  assert.ok(values.every(pose => !Object.hasOwn(pose, 'jaw_mid_open')));
});

test('ARKit61 brow/frown poses are independent from its smile-as-ee/jaw/eye/head values', () => {
  const source = provider({0: 1, 7: 1, 17: 1, 23: 1, 24: 1, 41: .5, 42: .75,
    43: .7, 44: .4, 45: .6, 52: 30, 55: -20});
  const result = expressionTarget({phase: 'speaking', providerFrame: source});
  assert.deepEqual(corners(result), [0, 0], 'Source ee smile shapes cannot classify an emotion');
  assert.ok(result.eye_l_brows_lower > 0 && result.eye_r_brows_lower > result.eye_l_brows_lower);
  assert.ok(Object.keys(result).every(track => EXPRESSION_TRACKS.includes(track)));
  const frown = expressionTarget({providerFrame: provider({25: .6, 26: .5})});
  assert.deepEqual(corners(frown), [0, 0]);
  assert.ok(frown.lips_l_corner_dn > 0);
});

test('unqualified/ambiguous facial formats drive no expression', () => {
  for (const providerFrame of [provider({}).values, {format: 'arkit52', values: Array(52).fill(1)},
    {format: 'arkit61', values: Array(61).fill(NaN)}, {format: 'arkit61', values: Array(60).fill(1)}])
    assert.ok(Object.values(expressionTarget({providerFrame})).every(value => value === 0));
});

test('speech contact/rounding gates additional mouth emotion without changing speech', () => {
  const emotion = {emotion: 'Joy', scale: 3};
  for (const speechPose of [{lips_together_up: .85, lips_together_dn: .85},
    {lips_l_funnel: .32, lips_r_funnel: .32}, {lips_l_purse: .28, lips_r_purse: .28}]) {
    const before = structuredClone(speechPose);
    const target = expressionTarget({emotion, phase: 'speaking', speechPose});
    assert.deepEqual(corners(target), [0, 0]);
    assert.deepEqual(speechPose, before);
    assert.ok(target.eye_l_brows_raise_out > 0, 'The upper-face intent need not disappear with a phoneme');
  }
});

test('final compositor reapplies contact budgets after a held/smoothed smile', () => {
  const smoother = new ExpressionSmoother();
  const smile = expressionTarget({emotion: {emotion: 'Joy', scale: 3}});
  for (let i = 0; i < 60; i++) smoother.update(smile, 1 / 60);
  const held = smoother.update(expressionTarget({phase: 'speaking'}), 1 / 60);
  assert.ok(held.lips_l_corner_up > 0, 'This verifies a real held smoothing state');
  const speech = {jaw_mid_open: .08493125, lips_together_up: .85, lips_together_dn: .85,
    lips_suck_up: .05342, tongue_mid_tip_up: .2345, eye_l_blink: .8, HeadYaw: -37};
  const result = composeExpressionPose(Object.freeze(speech), held, {phase: 'speaking'});
  assert.deepEqual(corners(result), [0, 0]);
  for (const [key, value] of Object.entries(speech)) assert.ok(Object.is(result[key], value));
});

test('immutable final composition preserves every accepted speech field exactly', () => {
  const speech = Object.freeze(Object.fromEntries(SPEECH_TRACKS.map((track, i) => [track, (i + 1) / 91])));
  const emotion = {emotion: 'Joy', scale: 2};
  const expr = expressionTarget({emotion, phase: 'speaking', speechPose: speech});
  const result = composeExpressionPose(speech, Object.freeze(expr), {phase: 'speaking'});
  assert.notEqual(result, speech);
  for (const track of SPEECH_TRACKS) assert.ok(Object.is(result[track], speech[track]), track);
  assert.equal(Object.keys(speech).length, SPEECH_TRACKS.length);
});

test('blocked/cancelled context discards expression immediately without resetting speech', () => {
  const speech = {jaw_mid_open: .4, lips_apart_up: .12, eye_r_blink: .7};
  const expr = expressionTarget({emotion: {emotion: 'Joy', scale: 3}});
  const result = composeExpressionPose(speech, expr, {blocked: true});
  for (const track of EXPRESSION_TRACKS) assert.equal(result[track], 0);
  for (const [key, value] of Object.entries(speech)) assert.equal(result[key], value);
});

test('expression payload cannot claim a speech, blinking or native gaze channel', () => {
  for (const track of ['jaw_mid_open', 'eye_l_blink', 'eye_l_widen', 'HeadYaw', 'tongue_mid_tip_up'])
    assert.throws(() => composeExpressionPose({}, {[track]: .1}), /owned tracks/);
  for (const value of [NaN, Infinity, -.01, 1])
    assert.throws(() => composeExpressionPose({}, {lips_l_corner_up: value}), /bounds/);
});

test('smoothing depends on gameplay time and preserves state while paused', () => {
  const target = expressionTarget({emotion: {emotion: 'Trust', scale: 2}});
  const samples = [10, 30, 60].map(fps => {
    const smoother = new ExpressionSmoother();
    let pose;
    for (let i = 0; i < fps; i++) pose = smoother.update(target, 1 / fps);
    const held = smoother.update(expressionTarget(), 100, {paused: true});
    assert.deepEqual(held, pose);
    return pose;
  });
  for (const track of EXPRESSION_TRACKS)
    assert.ok(Math.abs(samples[0][track] - samples[2][track]) < 1e-12, track);
});

test('per-copy emotion admission rejects missing/stale/different request ownership', () => {
  const signal = new OwnedExpressionSignal(owner.entity);
  signal.begin(owner);
  assert.equal(signal.accept({emotion: 'Joy', scale: 2}, undefined, 0), false);
  assert.equal(signal.accept({emotion: 'Joy', scale: 2}, {...owner, entity: 'copy-b'}, 0), false);
  assert.ok(signal.accept({emotion: 'Grief', scale: 2}, owner, 1));
  assert.equal(signal.accept({emotion: 'Joy', scale: 3}, owner, 1), false);
  const next = {...owner, requestId: 'reply-b', generation: 2};
  signal.begin(next);
  assert.equal(signal.accept({emotion: 'Joy', scale: 3}, owner, 2), false);
  assert.equal(signal.read(1000), null);
  assert.ok(signal.accept({emotion: 'Trust', scale: 1}, next, 0));
  signal.clear();
  assert.equal(signal.accept({emotion: 'Joy', scale: 3}, next, 1), false);
  assert.equal(signal.read(1001), null);
  assert.equal(sameExpressionOwner(owner, {...owner, generation: NaN}), false);
});

test('negative post-speech intent remains briefly but cannot leak after expiry/reload', () => {
  const signal = new OwnedExpressionSignal(owner.entity);
  signal.begin(owner); signal.accept({emotion: 'Grief', scale: 3}, owner, 0);
  assert.ok(signal.end(owner, 1000));
  assert.equal(signal.read(8999).family, 'sadness');
  assert.equal(signal.accept({emotion: 'Joy', scale: 1}, owner, 1), false);
  assert.equal(signal.read(9000), null);
  signal.begin(owner); signal.accept({emotion: 'Joy', scale: 3}, owner, 0); signal.end(owner, 1000);
  assert.equal(signal.read(4999).family, 'joy'); assert.equal(signal.read(5000), null);
  signal.begin(owner); signal.accept({emotion: 'Joy', scale: 3}, owner, 0); signal.end(owner, 1000);
  assert.equal(signal.read(999), null, 'A backwards/reloaded clock cannot revive a previous expression');
});

test('resting warmth is a floor under every non-negative intent, with a per-character gain and a Duchenne squint', () => {
  const R = EXPRESSION_POLICY;
  const interest = expressionTarget({emotion: {emotion: 'Interest', scale: 2}, phase: 'speaking'});
  assert.ok(Math.abs(interest.lips_l_corner_up - R.restSmile * R.speechMouthFactor) < 1e-9, 'Interest = brows + the resting smile');
  assert.ok(interest.eye_l_brows_raise_out > .08 && interest.eye_l_brows_raise_out < .12);
  for (const label of ['Surprise', 'Neutral', 'Interest', 'Trust'])
    assert.ok(expressionTarget({emotion: {emotion: label, scale: 1}, phase: 'speaking'}).lips_l_corner_up >= R.restSmile * R.speechMouthFactor - 1e-9, label);
  // Negative or unknown intent removes the floor; a stronger smile wins by max, never by sum.
  for (const label of ['Sadness', 'Anger', 'Fear', 'Disgust', 'Weird new label'])
    assert.equal(expressionTarget({emotion: {emotion: label, scale: 1}, phase: 'speaking'}).lips_l_corner_up, 0, label);
  const joy = expressionTarget({emotion: {emotion: 'Joy', scale: 3}, phase: 'idle'});
  assert.equal(joy.lips_l_corner_up, .45);
  // Warm characters rest higher, cold ones flat.
  assert.equal(expressionTarget({warmth: .15}).lips_l_corner_up, .15);
  assert.equal(expressionTarget({warmth: 0}).lips_l_corner_up, 0);
  // Gain (full lips): corners x1.5, caps x1.3 at most; brows are untouched.
  const gained = expressionTarget({emotion: {emotion: 'Joy', scale: 3}, gain: 1.5});
  assert.equal(gained.lips_l_corner_up, .5 * R.gainCapMax);
  assert.equal(expressionTarget({emotion: {emotion: 'Joy', scale: 2}, gain: 1.5}).lips_l_corner_up,
    .45 * R.scaleStrength[1] * 1.5);
  assert.equal(gained.eye_l_brows_raise_out, expressionTarget({emotion: {emotion: 'Joy', scale: 3}}).eye_l_brows_raise_out);
  // The squint follows the smile (before mouth priority), capped, and exists only with a smile.
  const smile = expressionTarget({emotion: {emotion: 'Joy', scale: 3}});
  assert.equal(smile.eye_l_oculi_squint_outer_lower, R.squintPerSmile * .45);
  assert.equal(smile.eye_r_oculi_squint_outer_lower, R.squintPerSmile * .45);
  assert.equal(gained.eye_l_oculi_squint_outer_lower, R.squintMax, 'the squint is capped');
  assert.equal(expressionTarget({emotion: {emotion: 'Anger', scale: 3}}).eye_l_oculi_squint_outer_lower, 0);
  // Mouth priority: closed lips remove the mouth corners, never the jaw/closure data.
  const closed = expressionTarget({emotion: {emotion: 'Joy', scale: 3}, phase: 'speaking', speechPose: {lips_together_up: .85, lips_together_dn: .85}});
  assert.equal(closed.lips_l_corner_up < .02, true);
});

test('blended mixes honour warmth, gain and the same mouth priority', () => {
  const bittersweet = mixTarget({weights: {joy: .5, sadness: .5}});
  assert.ok(bittersweet.lips_l_corner_up > .1 && bittersweet.eye_l_brows_raise_in > .2, 'a slight smile with sad brows');
  assert.equal(mixTarget({weights: {anticipation: .7}, phase: 'speaking'}).lips_l_corner_up, 0, 'Interest has no smile at the neutral rest');
  assert.equal(mixTarget({weights: {sadness: .8}, phase: 'speaking'}).lips_l_corner_up, 0);
  assert.equal(mixTarget({weights: {}, phase: 'speaking', warmth: 0}).lips_l_corner_up, 0);
  const closed = mixTarget({weights: {joy: 1}, phase: 'speaking', gain: 1.5, speechPose: {lips_l_funnel: .32, lips_r_funnel: .32, lips_l_purse: .28, lips_r_purse: .28}});
  assert.equal(closed.lips_l_corner_up, 0);
});
