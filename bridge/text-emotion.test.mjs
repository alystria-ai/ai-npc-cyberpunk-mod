import {test} from 'node:test';
import assert from 'node:assert/strict';
import {textEmotion, textExpression, textExpressionSignal} from './text-emotion.mjs';
import {ownedExpressionReceipt, expressionTarget} from './companion-expressions.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';
import {parseFaceModel, FaceModelStream} from './jali-face-model.mjs';
import {syntheticModel, speechLike} from './jali-face-fixture.mjs';

test('clear lexicon feelings map to one emotion; mixed, weak or negated text has no lexicon feeling', () => {
  assert.equal(textEmotion("Haha, that was preem! Best night in ages, choom.").emotion, 'Joy');
  assert.equal(textEmotion('I miss him. Jackie was family, and now he is gone. Sorry.').emotion, 'Sadness');
  assert.equal(textEmotion('Those bastards betrayed us. I hate them, I swear they will pay!').emotion, 'Anger');
  assert.equal(textEmotion('Wow, no way! You actually pulled it off?').emotion, 'Surprise');
  assert.equal(textEmotion('Careful, V. I got a bad feeling about this place.').emotion, 'Fear');
  assert.equal(textEmotion('Ugh, that smell is disgusting.').emotion, 'Disgust');
  // One clear word is now enough (October 6; it used to need two hits).
  assert.equal(textEmotion('Great.')?.emotion, 'Joy');
  for (const none of ['Sure, meet me at the Afterlife at nine.', 'I am not happy about this.',
    "Glad you're here, sorry it took so long.", 'Nice.', '', '   ', null])
    assert.equal(textEmotion(none), undefined, String(none));
  assert.equal(textEmotion('Haha! Amazing, wonderful, perfect, I love it, best day ever, hell yeah!').scale, 3);
});

test('Judy\'s October 6 reply, which left the face neutral, now reads as warm', () => {
  const reply = "I have my moments. Being with you... it makes things a lot easier to handle. "
    + "Most of the time, I'm just glad I've got someone I can actually trust in this city.";
  assert.equal(textEmotion(reply)?.emotion, 'Trust');
  const found = textExpression(reply, {profile: 'judy-alvarez'});
  assert.deepEqual({emotion: found.emotion, scale: found.scale}, {emotion: 'Trust', scale: 2});
  // A warm smile that is actually visible (about the game's own .10 smile).
  assert.ok(expressionTarget({emotion: found, phase: 'speaking'}).lips_l_corner_up * 1 >= .08);
});

test('every non-empty reply gets a cue: tone, then the character\'s resting warmth', () => {
  const plain = 'Sure, meet me at the Afterlife at nine.';
  assert.deepEqual(textExpression(plain, {profile: 'judy-alvarez'}), {emotion: 'Trust', scale: 2, basis: 'default'});
  assert.deepEqual(textExpression(plain, {profile: 'some-fixer'}), {emotion: 'Trust', scale: 1, basis: 'default'});
  assert.deepEqual(textExpression(plain), {emotion: 'Trust', scale: 1, basis: 'default'});
  // Cold characters stay alert but flat, without a smile.
  const cold = textExpression(plain, {profile: 'adam-smasher'});
  assert.deepEqual(cold, {emotion: 'Interest', scale: 1, basis: 'default'});
  assert.equal(expressionTarget({emotion: cold, phase: 'speaking', warmth: 0}).lips_l_corner_up, 0);
  // ...while every other character's Interest keeps its resting warmth under the brows.
  const curious = expressionTarget({emotion: {emotion: 'Interest', scale: 2}, phase: 'speaking'});
  assert.ok(curious.lips_l_corner_up > .05 && curious.eye_l_brows_raise_out > .08);
  // A question lifts the brows; an exclamation smiles; a refused positive stays flat.
  assert.equal(textExpression('What do you want to do next?').emotion, 'Interest');
  assert.equal(textExpression('Move it, we are leaving!').emotion, 'Joy');
  assert.deepEqual(textExpression('I am not happy about this.', {profile: 'judy-alvarez'}), {emotion: 'Interest', scale: 1, basis: 'tone'});
  for (const nothing of ['', '   ', null, undefined, 'x'.repeat(12001)]) assert.equal(textExpression(nothing), undefined);
});

test('the corpus of ordinary replies is mostly non-neutral and never an unknown label', () => {
  const lines = ["Haha, that was preem!", 'Those bastards betrayed us!', 'I miss him. Sorry.', 'Wow, no way!',
    'We should keep moving.', 'Okay.', 'What now?', 'Thanks, V. You are a good friend.', 'Ugh, that is disgusting.',
    'It was dark and empty out there.', "I do not know. Maybe. Let me think."];
  const families = new Set();
  for (const line of lines) {
    const cue = textExpression(line, {profile: 'panam-palmer'});
    assert.ok(cue && cue.scale >= 1 && cue.scale <= 3, line);
    families.add(cue.emotion);
  }
  assert.ok(families.size >= 5, [...families].join());
});

test('the local expression signal has the exact shape the receipt path admits', () => {
  const signal = textExpressionSignal('I miss him. Jackie is gone. Sorry.');
  assert.deepEqual({...signal, scale: undefined}, {version: 1, correlated: true, sequence: 0, emotion: 'Sadness', scale: undefined, basis: 'text'});
  assert.equal(textExpressionSignal(''), undefined);
  assert.equal(textExpressionSignal('Okay.', {profile: 'judy-alvarez'}).basis, 'default');
  const owner = {entity: '11465605ULL', requestId: '1791269594-5-11465605ULL', generation: 5};
  assert.deepEqual(ownedExpressionReceipt(textExpressionSignal('Okay.', {profile: 'judy-alvarez'}), owner),
    {version: 1, ...owner, sequence: 0, emotion: 'Trust', scale: 2});
});

test('an Omni (JALI) timeline carries the default cue to the game as an expression receipt', () => {
  const {meta, buffer} = syntheticModel({lookahead: 2, upper: true}), model = parseFaceModel(meta, buffer);
  const pcm = speechLike(1.2, 24000), stream = new FaceModelStream(model, 24000);
  stream.push(pcm); stream.finish();
  const owner = {entity: '11465605ULL', requestId: '1791269594-5-11465605ULL', generation: 5};
  const expressionSignal = textExpressionSignal('Sure, meet me at the Afterlife at nine.', {profile: 'judy-alvarez'});
  const wav = Buffer.from(pcm.length ? Buffer.concat([Buffer.alloc(44), Buffer.from(Int16Array.from(pcm, v => Math.round(v * 32767)).buffer)]) : []);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const timeline = buildFacialTimeline({audio: wav.toString('base64'), jaliFrames: stream, expressionSignal}, owner);
  assert.equal(timeline.articulation, 'jali-audio-v1');
  assert.deepEqual(timeline.expression, {version: 1, ...owner, sequence: 0, emotion: 'Trust', scale: 2});
  assert.equal(timeline.modelExpressions.format, 'jali-upper-v1');
});
