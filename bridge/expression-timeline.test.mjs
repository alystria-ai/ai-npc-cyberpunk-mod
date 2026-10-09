import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyseReply, planRange, phraseOffsets, FAMILIES} from './emotion-analysis.mjs';
import {speechActivity, findPauses, alignSegments, buildTrack, attachExpressionTrack, sampleTrack,
  LEAD_SECONDS, BLEND_SECONDS, TRACK_FORMAT, timelineRecord} from './expression-timeline.mjs';
import {SpeechStream, SpeechSlots} from './speech-stream.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {silentWav} from './speech-audio.mjs';
import {mixTarget} from './companion-expressions.mjs';

const fam = name => FAMILIES.indexOf(name);
// A mouth timeline whose jaw is open in the given spoken ranges and closed in the silences.
function face(ranges, duration, {complete = true} = {}) {
  const frames = [];
  for (let i = 0; i / 60 <= duration + 1e-9; i++) {
    const t = i / 60, speaking = ranges.some(([a, b]) => t >= a && t < b);
    frames.push([t, speaking ? .28 + .08 * Math.sin(t * 40) : 0, speaking ? .06 : 0, speaking ? .08 : 0]);
  }
  return {version: 1, duration, complete, source: 'local-jali', tracks: ['jaw_mid_open', 'lips_apart_up', 'lips_apart_dn'], frames};
}
const text = "Haha, that was preem! But honestly, I'm worried about what comes next. I miss him.";
const speechRanges = [[.2, 2.5], [3.1, 5.7], [6.4, 8.2]];   // real pauses at 2.5-3.1 and 5.7-6.4
const truth = [.2, 3.1, 6.4];                                // the real audio start of each segment
const plan = () => analyseReply(text, {profile: 'some-fixer'});

test('pauses in the mouth timeline are found and leading/trailing silence is not a pause', () => {
  const found = findPauses(speechActivity(face(speechRanges, 8.6)));
  assert.equal(found.pauses.length, 2);
  assert.ok(Math.abs(found.onset - .2) < .03 && Math.abs(found.offset - 8.2) < .03);
  assert.ok(Math.abs(found.pauses[0].start - 2.5) < .03 && Math.abs(found.pauses[0].end - 3.1) < .03);
  // A brief closure inside a word is not a pause.
  const brief = findPauses(speechActivity(face([[.1, 1], [1.08, 2]], 2.2)));
  assert.equal(brief.pauses.length, 0);
  assert.deepEqual(findPauses(undefined), {onset: 0, offset: 0, pauses: []});
});

test('each segment is anchored to its REAL audio start, not to its position in the text', () => {
  const p = plan(), f = face(speechRanges, 8.6);
  assert.equal(p.segments.length, 3);
  // The text-proportional guess lands far from the truth, so this proves pause anchoring.
  const guess = alignSegments(p.segments, {duration: 8.6, complete: true}).starts;
  const anchored = alignSegments(p.segments, {duration: 8.6, complete: true, activity: speechActivity(f)});
  anchored.starts.forEach((start, i) => assert.ok(Math.abs(start - truth[i]) <= .05, `segment ${i}: ${start} vs ${truth[i]}`));
  assert.ok(anchored.resolved.every(Boolean));
  assert.ok(Math.abs(guess[1] - truth[1]) > .25 || Math.abs(guess[2] - truth[2]) > .25, `estimate ${guess} is not the truth`);
});

test('an expression starts within a small tolerance of its segment audio start, with a slight lead, then blends and holds', () => {
  const p = plan(), f = attachExpressionTrack(face(speechRanges, 8.6), p);
  const track = f.expressionTrack;
  assert.equal(track.format, TRACK_FORMAT); assert.deepEqual(track.families, FAMILIES);
  [1, 2].forEach(i => {
    const start = track.segments[i].start, before = sampleTrack(track, start - LEAD_SECONDS - .05),
      mid = sampleTrack(track, start - LEAD_SECONDS + BLEND_SECONDS / 2), after = sampleTrack(track, start + BLEND_SECONDS);
    const want = FAMILIES.map(family => p.segments[i].weights[family] || 0), was = FAMILIES.map(family => p.segments[i - 1].weights[family] || 0);
    const dist = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));
    // Nothing has changed before the lead window; the new phrase's weights are in place by its audio start + the blend.
    assert.ok(dist(before, was) < .02, `segment ${i} changed too early`);
    assert.ok(dist(after, want) < .03, `segment ${i} not in place at start+blend`);
    assert.ok(dist(mid, was) > .05 && dist(mid, want) > .05, 'blending, not snapping');
    // The first visible change lands between 250 ms before and 50 ms after the audio start (lead ~200 ms).
    const changeAt = [...Array(400).keys()].map(k => start - .5 + k / 400).find(t => dist(sampleTrack(track, t), was) > .02);
    assert.ok(changeAt >= start - .25 && changeAt <= start + .05, `change at ${changeAt - start}`);
    // And the phrase is held until the next one begins.
    if (i === 1) assert.ok(dist(sampleTrack(track, start + 1.5), want) < .02);
  });
  // Audible start of the reply: the first phrase's expression is already in place from t = 0.
  assert.deepEqual(sampleTrack(track, 0).map(v => Math.round(v * 1000) / 1000),
    FAMILIES.map(family => p.segments[0].weights[family] || 0));
});

test('the track never snaps: frame-to-frame change stays small and the mix stays inside the caps', () => {
  const track = attachExpressionTrack(face(speechRanges, 8.6), plan()).expressionTrack;
  let previous = sampleTrack(track, 0);
  for (let i = 1; i <= 8.6 * 60; i++) {
    const now = sampleTrack(track, i / 60);
    now.forEach((value, k) => { assert.ok(Math.abs(value - previous[k]) < .1, `step ${i} family ${k}`); assert.ok(value >= 0 && value <= 1); });
    const pose = mixTarget({weights: now, phase: 'speaking'});
    assert.ok(Object.values(pose).every(value => value >= 0 && value <= .9));
    previous = now;
  }
  assert.ok(track.keys.length <= 160);
  track.keys.forEach((key, i) => i && assert.ok(key[0] > track.keys[i - 1][0]));
});

test('the last phrase decays to the character baseline; an inner chunk holds', () => {
  const p = plan(), last = attachExpressionTrack(face(speechRanges, 8.6), p, {decay: true}).expressionTrack;
  const inner = attachExpressionTrack(face(speechRanges, 8.6), p, {decay: false}).expressionTrack;
  const end = sampleTrack(last, 8.6 + .6).map(v => Math.round(v * 1000) / 1000);
  assert.deepEqual(end, FAMILIES.map(family => p.baseline[family] || 0));
  assert.ok(sampleTrack(last, 8.0)[fam('sadness')] > .2, 'still the sad phrase while it is spoken');
  assert.ok(sampleTrack(inner, 9)[fam('sadness')] > .2, 'a non-final chunk keeps its weights until the next chunk');
});

test('a growing prefix keeps resolved boundaries and estimates the unheard rest; completion refines it', () => {
  const p = plan();
  const early = attachExpressionTrack(face(speechRanges, 4, {complete: false}), p, {complete: false}).expressionTrack;
  assert.equal(early.segments[1].anchored, true);
  assert.ok(Math.abs(early.segments[1].start - 3.1) <= .05);
  assert.equal(early.segments[2].anchored, false, 'the third phrase has not been heard yet');
  assert.ok(early.segments[2].start > 4, 'its estimated start is in the future');
  const done = attachExpressionTrack(face(speechRanges, 8.6), p).expressionTrack;
  assert.ok(Math.abs(done.segments[1].start - early.segments[1].start) < .01, 'stable once resolved');
  assert.ok(Math.abs(done.segments[2].start - 6.4) <= .05);
  // The unheard boundary is only an estimate; it is replaced by the real pause once heard.
  assert.ok(Math.abs(done.segments[2].start - early.segments[2].start) > .01 || early.segments[2].anchored === false);
});

test('without any pause evidence the plan falls back to duration estimates scaled to the audio', () => {
  const p = plan();
  const flat = {...face([[0, 8.6]], 8.6)};
  const aligned = alignSegments(p.segments, {duration: 8.6, complete: true, activity: speechActivity(flat)});
  assert.equal(aligned.resolved.filter(Boolean).length, 1, 'only the first segment (the onset) is evidence');
  aligned.starts.forEach((start, i) => i && assert.ok(start > aligned.starts[i - 1] + .2 && start < 8.6));
  assert.ok(aligned.starts.at(-1) > 5, 'the estimate follows the text length');
  const none = attachExpressionTrack({version: 1, duration: 3, tracks: ['x'], frames: [[0, 0], [3, 0]]}, p);
  assert.ok(none.expressionTrack, 'a timeline without jaw rows still gets estimated phrases');
});

test('attaching is optional and never throws: bad plans and faces return the face unchanged', () => {
  const f = face(speechRanges, 8.6);
  assert.equal(attachExpressionTrack(f, undefined), f);
  assert.equal(attachExpressionTrack(f, {segments: []}), f);
  assert.equal(attachExpressionTrack(null, plan()), null);
  assert.equal(attachExpressionTrack({...f, duration: 0}, plan()).expressionTrack, undefined);
  assert.equal(JSON.stringify(attachExpressionTrack(f, plan())).includes('worried'), false, 'no dialogue text in the track');
});

test('a bittersweet segment blends two families through the same mouth-priority pose', () => {
  const p = analyseReply('I am so happy for you, and it makes me sad to see you go.', {profile: 'some-fixer'});
  const track = attachExpressionTrack(face([[.1, 4.2]], 4.4), p).expressionTrack;
  const mixed = sampleTrack(track, 2);
  assert.ok(mixed[fam('joy')] > .2 && mixed[fam('sadness')] > .2);
  const pose = mixTarget({weights: mixed, phase: 'speaking'});
  assert.ok(pose.lips_l_corner_up > 0 && pose.lips_l_corner_dn === 0 && pose.eye_l_brows_raise_in > .1, 'smile with sad brows');
  const closed = mixTarget({weights: mixed, phase: 'speaking', speechPose: {lips_together_up: .85, lips_together_dn: .85}});
  assert.ok(closed.lips_l_corner_up < .02, 'closure still wins');
});

// ---- Omni: each phrase is its own audio file and its own timeline ----------
test('Omni: every phrase timeline carries the expression of ITS OWN phrase, starting at its own audio start', async () => {
  const phrases = ['Haha, that was preem!', 'But honestly, I am worried about what comes next.'];
  const full = phrases.join(' ');
  const spans = phraseOffsets(full, phrases);
  const p = analyseReply(full, {profile: 'some-fixer', breaks: spans.slice(1).map(span => span[0])});
  const owner = {requestId: 'omni-expr', generation: 4, entity: 'judy-2'};
  const state = {};
  const manifests = [];
  const slots = new SpeechSlots({depot: 'unused', readState: async () => state, store: async (b, d, slot) => ({slot, event: `convai_reply_${slot}`, duration: 2})});
  const stream = new SpeechStream({input: owner, steps: 32, phrases, slots, current: async () => true, readState: async () => state,
    writeManifest: async value => manifests.push(structuredClone(value)), wait: () => Promise.resolve(),
    synthesize: async () => ({audio: silentWav().toString('base64'), timing: {}}), expressionPlan: p, spans});
  const first = await stream.begin({audio: silentWav().toString('base64'), timing: {}, expressionPlan: p});
  assert.ok(first.face?.expressionTrack, 'the first phrase gets a track');
  assert.equal(first.face.expressionTrack.keys[0][0], 0, 'its track starts at its own audio start');
  const joy = first.face.expressionTrack.keys[0][1 + fam('joy')];
  assert.ok(joy > .5, 'phrase one is the laugh');
  assert.equal(first.face.expressionTrack.segments.length, 1);
  // Phrase two is built by finish(); acknowledge the first chunk so it may proceed.
  state.requestId = owner.requestId; state.state = 'playing'; state.updated = Date.now(); state.streamId = stream.manifest.streamId; state.completedChunk = 1;
  await stream.finish();
  const second = stream.manifest.chunks[1].face.expressionTrack;
  assert.ok(second.keys[0][1 + fam('anticipation')] === 0 || second.keys[0][1 + fam('fear')] > .3, 'phrase two reads the worry, not the laugh');
  assert.ok(second.keys[0][1 + fam('joy')] < .2);
  assert.equal(second.keys[0][0], 0);
});

// ---- Pocket / Convai continuous streams -----------------------------------
test('continuous streams attach a track from the received text and audio, re-planning as the text grows', async () => {
  const faces = [], documents = [];
  const input = {requestId: 'cont', generation: 4, entity: 'judy-2', profileKey: 'some-fixer'};
  const planned = [];
  const speech = new ConvaiContinuousSpeech({input, profile: {key: 'some-fixer'}, current: Object.assign(async () => true, {sync: () => true}),
    signal: undefined, faceBuilder: (snapshot) => face(speechRanges, snapshot.duration, {complete: snapshot.complete}),
    planExpression: (value, signal) => { planned.push([value, signal?.emotion]); return analyseReply(value, {profile: 'some-fixer'}); },
    readControl: async () => '{}', writeState: async value => { documents.push(value); return true; },
    writeReply: async () => true, onPublished: async () => {}, onStarted: async () => {}, onGenerated: async () => {}, onText: () => {}});
  const base = {version: 1, token: speech.token, sampleRate: 24000, channels: 1, receivedFrames: 24000 * 4, positionSeconds: 1,
    textComplete: false, sourceComplete: false, ended: false, underruns: 0, state: 'playing'};
  await speech.frame({...base, text: 'Haha, that was preem! But honestly, I am worried'});
  const first = documents.at(-1).face;
  assert.ok(first.expressionTrack, 'a growing prefix already carries a track');
  assert.equal(first.expressionTrack.segments[0].anchored, true);
  await speech.frame({...base, text: text, receivedFrames: 24000 * 8, positionSeconds: 3, textComplete: true});
  const second = documents.at(-1).face;
  assert.ok(second.expressionTrack.segments.length >= 3, 'more phrases as more text arrives');
  assert.ok(planned.length >= 2 && planned[0][0] !== planned[1][0]);
  // The reply's timeline is reported once, when its text and audio source are both complete.
  const timelines = [];
  const finishing = new ConvaiContinuousSpeech({input, profile: {key: 'some-fixer'}, current: Object.assign(async () => true, {sync: () => true}),
    signal: undefined, faceBuilder: (snapshot) => face(speechRanges, snapshot.duration, {complete: snapshot.complete}),
    planExpression: value => analyseReply(value, {profile: 'some-fixer'}), readControl: async () => '{}', writeState: async () => true,
    writeReply: async () => true, onText: () => {}, onTimeline: timeline => timelines.push(timeline)});
  const done = {...base, token: finishing.token, text, receivedFrames: 24000 * 8, positionSeconds: 3, textComplete: true, sourceComplete: true};
  await finishing.frame({...done, sourceComplete: false, positionSeconds: 2});
  assert.equal(timelines.length, 0, 'not reported while the source is still arriving');
  await finishing.frame(done);
  await finishing.frame(done);
  assert.equal(timelines.length, 1, 'reported exactly once per reply');
  assert.equal(timelines[0].text, text);
  assert.ok(timelines[0].plan.segments.length >= 3 && timelines[0].face.expressionTrack, 'with the plan and the aligned face');
});

test('timeline record: each planned part with its text, emotion, intensity and aligned start; provider label only when admitted', () => {
  const reply = 'Fine. We leave now, and you shut up.';
  const plan = {selector: 'context', summary: {family: 'anger', label: 'Anger', weight: .5, basis: 'text', scale: 2},
    segments: [
      {start: 0, end: 6, dominant: 'trust', weights: {trust: .4}, tags: ['llm-emotion']},
      {start: 6, end: 21, dominant: 'anger', weights: {anger: .55, sadness: .2}, tags: []},
      {start: 21, end: 36, dominant: null, weights: {}, tags: []}]};
  const face = {expressionTrack: {segments: [{from: 0, start: 0}, {from: 6, start: .8}, {from: 21, start: 2.1}]}};
  const record = timelineRecord({requestId: 'r1', speaker: 'Judy Alvarez', profile: 'judy-alvarez', provider: 'omni',
    reply, plan, face, signal: {emotion: 'Anger', scale: 2, basis: 'ordered'}, at: Date.UTC(2026, 9, 9)});
  assert.equal(record.at, '2026-10-09T00:00:00.000Z');
  assert.equal(record.speaker, 'Judy Alvarez');
  assert.deepEqual(record.convai, {emotion: 'Anger', scale: 2, basis: 'ordered'});
  assert.deepEqual(record.segments.map(s => [s.text, s.emotion, s.intensity, s.start]),
    [[reply.slice(0, 6), 'trust', .4, 0], [reply.slice(6, 21), 'anger', .55, .8], [reply.slice(21, 36), null, 0, 2.1]]);
  // A text-only or unadmitted signal is not the provider's emotion.
  assert.equal(timelineRecord({reply, plan, signal: {emotion: 'Joy', scale: 1, basis: 'text'}}).convai, null);
  // A track that does not line up with the plan leaves the starts unknown rather than wrong.
  const misaligned = timelineRecord({reply, plan, face: {expressionTrack: {segments: [{from: 0, start: 0}]}}});
  assert.ok(misaligned.segments.every(s => s.start === null));
  assert.equal(timelineRecord({reply: 'x', plan: {segments: []}}), undefined);
});
