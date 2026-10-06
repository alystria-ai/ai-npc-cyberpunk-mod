import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyseReply, segmentText, planSignal, planRange, phraseOffsets, createPlanner, baselineFromSignal, traitFor, TRAITS, FAMILIES}
  from './emotion-analysis.mjs';

const plan = (text, options = {}) => analyseReply(text, {profile: 'some-fixer', ...options});
const spans = (text, result) => result.segments.map(segment => text.slice(segment.start, segment.end));
const top = segment => Object.entries(segment.feelings).sort((a, b) => b[1] - a[1])[0]?.[0];

test('segments follow sentences, contrast words, long clauses and forced boundaries', () => {
  const text = "I have my moments. Being with you... it makes things easier. Haha, that was preem! But honestly, I'm worried about what comes next.";
  assert.deepEqual(spans(text, plan(text)), ['I have my moments.', 'Being with you...', 'it makes things easier.',
    'Haha, that was preem!', "But honestly, I'm worried about what comes next."]);
  // Contrast splits one sentence in two; the second clause starts at the contrast word.
  const contrast = 'I love this place, but the people here scare me.';
  const parts = plan(contrast);
  assert.deepEqual(spans(contrast, parts), ['I love this place,', 'but the people here scare me.']);
  assert.ok(parts.segments[1].tags.includes('contrast') && parts.segments[0].tags.includes('pre-contrast'));
  // A forced boundary (an Omni phrase edge) splits inside a sentence at a word boundary.
  const long = 'We should go now before the patrol comes back around the corner and sees us standing here.';
  const edge = long.indexOf('around');
  const forced = plan(long, {breaks: [edge]});
  assert.deepEqual(spans(long, forced).map(part => part.trim()), [long.slice(0, edge).trim(), long.slice(edge)]);
  // Abbreviations and a single V. do not end a sentence; one-word fragments merge.
  assert.equal(plan('Dr. Hellman said so. Fine.').segments.length >= 1, true);
  assert.equal(spans('Mr. Hands waits. Yes.', plan('Mr. Hands waits. Yes.')).length, 1);
  // Long unpunctuated clauses split at a comma near the middle.
  const clauses = 'When we first got to Night City we had nothing at all, no money, no friends, and no plan except to survive another night.';
  assert.equal(plan(clauses).segments.length, 2);
});

test('segment feelings differ across a reply: a mixed story moves joy, fear and sadness over time', () => {
  const text = "Haha, that was preem! But honestly, I'm worried about what comes next. I miss him. Sorry.";
  const result = plan(text);
  assert.equal(top(result.segments[0]), 'joy');
  assert.equal(top(result.segments[1]), 'fear');
  assert.equal(top(result.segments[2]), 'sadness');
  assert.ok(result.segments.every(segment => segment.seconds > 0 && segment.syllables > 0));
});

test('negation scope flips a feeling inside three words and not across a clause', () => {
  const happy = plan("I'm happy about this.").segments[0].weights;
  const notHappy = plan("I'm not happy about this.").segments[0];
  assert.ok(happy.joy > .4);
  assert.equal(notHappy.weights.joy, undefined);
  assert.ok(notHappy.weights.sadness > 0 && notHappy.tags.includes('negation'));
  const relief = plan("I'm not scared anymore.").segments[0];
  assert.equal(relief.weights.fear, undefined);
  assert.ok(relief.weights.trust > .3, 'relief reads as trust');
  // A comma ends the negation's reach.
  assert.ok(plan("No, I'm happy.").segments[0].weights.joy > .4);
  // Double negation cancels.
  assert.ok(plan("I can't not be happy.").segments[0].weights.joy > .2);
  // ...and the reach is three words: a negator further back does not apply.
  assert.ok(plan("Never mind that, I am so very happy today.").segments[0].weights.joy > .4);
});

test('intensifiers and diminishers scale the next feeling word', () => {
  const base = plan('I am angry.').segments[0].feelings.anger;
  const very = plan('I am really furious.').segments[0].feelings.anger;
  const slight = plan('I am slightly angry.').segments[0].feelings.anger;
  assert.ok(very > base && (slight === undefined || slight < base), `${slight} < ${base} < ${very}`);
});

test('contrast shifts emphasis: the clause after "but" outweighs the one before', () => {
  const result = plan('I was happy with the job, but I hate how it ended.');
  const [before, after] = result.segments;
  assert.ok(before.tags.includes('pre-contrast') && after.tags.includes('contrast'));
  assert.equal(top(before), 'joy'); assert.equal(top(after), 'anger');
  assert.ok(after.feelings.anger >= .6 && before.feelings.joy < after.feelings.anger);
});

test('questions, exclamations, ellipses, laughter, profanity, address and sarcasm each leave a mark', () => {
  assert.ok(plan('What do you want to do?').segments[0].feelings.anticipation > .2);
  const calm = plan('That worked.').segments[0], loud = plan('That worked!').segments[0];
  assert.ok(loud.tags.includes('exclamation') && (loud.weights.anticipation || 0) >= (calm.weights.anticipation || 0));
  const hesitant = plan('Well... I guess you could say I am glad.').segments;
  assert.ok(hesitant.some(segment => segment.tags.includes('hesitation')));
  assert.equal(top(plan('Haha, hehe, you got me.').segments[0]), 'joy');
  assert.ok(plan('Hahahaha!').segments[0].tags.includes('laugh'));
  // Profanity: anger on its own, emphasis when it modifies a pleasant word.
  const furious = plan('Get out of my fucking way.').segments[0];
  assert.ok(furious.tags.includes('profanity') && furious.feelings.anger > .2);
  const amazing = plan('That was fucking amazing!').segments[0];
  assert.equal(top(amazing), 'joy');
  assert.ok(amazing.feelings.joy >= plan('That was amazing!').segments[0].feelings.joy);
  // Affectionate address adds trust; a vocative V counts.
  assert.ok(plan('Take care, choom.').segments[0].weights.trust > TRAITS.neutral.baseline.trust);
  assert.ok(plan('Listen, V, we got this.').segments[0].tags.includes('address'));
  // Sarcasm removes the joy and leaves a dry smirk (disgust brow, thinking brow).
  const sarcastic = plan('Oh, great, another gig. Thanks a lot.');
  assert.ok(sarcastic.segments.some(segment => segment.tags.includes('sarcasm')));
  assert.equal(sarcastic.segments.at(-1).weights.joy, undefined);
  assert.ok(sarcastic.segments.at(-1).weights.disgust > 0);
});

test('mixed states are kept as several weights (bittersweet) rather than one label', () => {
  const result = plan('I am so happy for you, and it makes me sad to see you go.');
  const mixed = result.segments.find(segment => segment.mixed);
  assert.ok(mixed, JSON.stringify(result.segments.map(segment => segment.feelings)));
  assert.ok(mixed.feelings.joy > .2 && mixed.feelings.sadness > .2);
});

test('characters differ: a warm baseline, a dry one, and a cold flat one with a narrower range', () => {
  const plain = 'We should keep moving.';
  const judy = plan(plain, {profile: 'judy-alvarez'}), johnny = plan(plain, {profile: 'johnny-silverhand'});
  const smasher = plan(plain, {profile: 'adam-smasher'}), other = plan(plain);
  assert.deepEqual([judy.trait, johnny.trait, smasher.trait, other.trait], ['warm', 'dry', 'cold', 'neutral']);
  assert.equal(judy.segments[0].weights.trust, .67);
  assert.ok(johnny.segments[0].weights.trust < other.segments[0].weights.trust);
  assert.equal(smasher.segments[0].weights.trust, undefined);
  assert.ok(smasher.segments[0].weights.anticipation > 0);
  const happy = 'I am glad.';
  assert.ok(plan(happy, {profile: 'adam-smasher'}).segments[0].feelings.joy < plan(happy, {profile: 'judy-alvarez'}).segments[0].feelings.joy,
    'the cold range is narrower');
  assert.equal(traitFor('unknown-profile'), 'neutral');
});

test('a negative phrase suppresses the resting smile, and a quiet one returns to baseline', () => {
  const result = plan('I miss him. We keep going.', {profile: 'judy-alvarez'});
  assert.ok((result.segments[0].weights.trust || 0) < .35, 'grief takes the warm smile down');
  assert.equal(result.segments[1].weights.trust, .67);
});

test('a Convai reply-level label is the baseline, phrase analysis varies it, and our own cue is never mistaken for it', () => {
  const baseline = baselineFromSignal({emotion: 'Sadness', scale: 2, basis: 'ordered'});
  assert.deepEqual(baseline, {family: 'sadness', weight: .67});
  assert.equal(baselineFromSignal({emotion: 'Trust', scale: 2, basis: 'text'}), undefined);
  assert.equal(baselineFromSignal({emotion: 'Mystery', scale: 1, basis: 'ordered'}), undefined);
  const result = plan('Okay, fine. Haha, that is funny!', {baseline});
  assert.ok(result.segments[0].weights.sadness >= .35, 'baseline colours a quiet phrase');
  assert.equal(top(result.segments[1]), 'joy', 'the funny phrase still reads');
  assert.ok(result.segments[1].weights.joy > result.segments[1].weights.sadness);
  const planner = createPlanner({profile: 'some-fixer'});
  const first = planner('Okay. Fine.', {emotion: 'Anger', scale: 3, basis: 'ordered'});
  assert.equal(planner('Okay. Fine.', {emotion: 'Anger', scale: 3, basis: 'ordered'}), first, 'one-entry cache');
  assert.ok(planner('Okay. Fine.', undefined) !== first);
});

test('reply-level cue, ranges and offsets', () => {
  const text = 'Ugh, that smell is disgusting. Let us get out of here before I puke.';
  const result = plan(text);
  assert.deepEqual(planSignal(result), {version: 1, correlated: true, sequence: 0, emotion: 'Disgust', scale: 2, basis: 'text'});
  assert.equal(planSignal(plan('Sure, meet me there.', {profile: 'adam-smasher'})).emotion, 'Interest');
  assert.equal(planSignal(undefined), undefined);
  const offsets = phraseOffsets(text, ['Ugh, that smell is disgusting.', 'Let us get out of here before I puke.']);
  assert.deepEqual(offsets, [[0, 30], [31, 68]]);
  const second = planRange(result, ...offsets[1]);
  assert.equal(second.segments.length, 1);
  assert.equal(second.segments[0].start, 0);
  assert.equal(second.segments[0].end, 37);
  assert.equal(analyseReply(''), undefined); assert.equal(analyseReply(null), undefined);
  assert.equal(analyseReply('x'.repeat(12001)), undefined);
  assert.ok(FAMILIES.length === 8);
});

test('analysis is cheap and its plan carries no dialogue text', () => {
  const text = "I have my moments. Being with you... it makes things a lot easier to handle. Most of the time, I'm just glad I've got someone I can actually trust in this city. ".repeat(4);
  const started = performance.now();
  for (let i = 0; i < 20; i++) analyseReply(text, {profile: 'judy-alvarez'});
  assert.ok((performance.now() - started) / 20 < 10, 'a few milliseconds per reply');
  const serialised = JSON.stringify(plan('Haha, you magnificent bastard, that worked!'));
  assert.equal(/bastard|magnificent|worked/.test(serialised), false);
  assert.equal(segmentText('').length, 0);
});
