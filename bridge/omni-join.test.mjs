import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PhraseJoiner, measureSpeech, phraseEnding, JOIN_RATE, LEAD_KEEP_MS, TAIL_KEEP_MS, LAST_TAIL_KEEP_MS, PAUSE_SENTENCE_MS, PAUSE_CLAUSE_MS, PAUSE_PLAIN_MS} from './omni-join.mjs';

const ms = value => Math.round(value * JOIN_RATE / 1000);
// Silence, a 220 Hz tone, silence: the shape of an OmniVoice phrase.
function phrase({lead = 500, speech = 1500, tail = 250, level = 0.3} = {}) {
  const out = new Float32Array(ms(lead) + ms(speech) + ms(tail));
  for (let n = 0; n < ms(speech); n++) out[ms(lead) + n] = level * Math.sin(2 * Math.PI * 220 * n / JOIN_RATE);
  return out;
}
const silenceAfter = (pcm, from) => { let run = 0; for (let n = from; n < pcm.length && Math.abs(pcm[n]) < 1e-5; n++) run++; return run; };

test('the end of a phrase\'s text tells how it was cut', () => {
  for (const [text, ending] of [['Hello there.', 'sentence'], ['Really?!', 'sentence'], ['She said "stop."', 'sentence'], ['你好。', 'sentence'], ['and then,', 'clause'], ['wait -', 'clause'], ['and then', 'plain'], ['', 'plain'], [undefined, 'plain']]) {
    assert.equal(phraseEnding(text), ending, String(text));
  }
});

test('the speech is found by its loudness, well below a quiet consonant, and silence has none', () => {
  const pcm = phrase({lead: 400, speech: 1000, tail: 300});
  // A faint noise floor in the padding (-60 dB of the speech) does not count as speech.
  for (let n = 0; n < pcm.length; n += 7) if (pcm[n] === 0) pcm[n] = 0.0003 * Math.sin(n);
  const found = measureSpeech(pcm);
  assert.ok(Math.abs(found.start - ms(400)) <= ms(10), `start ${found.start}`);
  assert.ok(Math.abs(found.end - ms(1400)) <= ms(10), `end ${found.end}`);
  assert.ok(Math.abs(found.level - 0.3 / Math.SQRT2) < 0.01);
  assert.equal(measureSpeech(new Float32Array(24000)), null);
  assert.equal(measureSpeech(new Float32Array(10)), null);
});

test('the first phrase loses the model\'s padding (but keeps a little air), is faded at the end and is otherwise left as rendered', () => {
  const raw = phrase({lead: 600, speech: 1200, tail: 300});
  const joiner = new PhraseJoiner();
  const out = joiner.shape(raw, {text: 'Hello there V.', first: true, last: false});
  const found = measureSpeech(out);
  assert.equal(found.start, ms(LEAD_KEEP_MS), 'the sound starts after the kept lead');
  assert.equal(out.length, ms(LEAD_KEEP_MS) + ms(1200) + ms(TAIL_KEEP_MS));
  // Samples in the middle are the file\'s own, untouched.
  const middle = ms(LEAD_KEEP_MS) + ms(600);
  assert.equal(out[middle], raw[ms(600) + ms(600)]);
  assert.equal(out[out.length - 1], 0);
});

test('a pause of a speaker\'s length follows a sentence, a comma or a plain cut, counted from sound to sound', () => {
  for (const [text, wanted] of [['That is it.', PAUSE_SENTENCE_MS], ['and then,', PAUSE_CLAUSE_MS], ['and then', PAUSE_PLAIN_MS]]) {
    const joiner = new PhraseJoiner();
    const one = joiner.shape(phrase(), {text, first: true});
    const two = joiner.shape(phrase({lead: 800, tail: 100}), {text: 'More.', last: true});
    const whole = Float32Array.from([...one, ...two]);
    const firstEnd = measureSpeech(one).end, secondStart = one.length + measureSpeech(two).start;
    const gap = (secondStart - firstEnd) * 1000 / JOIN_RATE;
    assert.ok(Math.abs(gap - wanted) < 15 || (wanted < LEAD_KEEP_MS + TAIL_KEEP_MS && gap <= LEAD_KEEP_MS + TAIL_KEEP_MS + 15), `${text}: ${gap.toFixed(0)} ms for ${wanted}`);
    assert.ok(whole.length > one.length);
  }
});

test('the last phrase keeps a longer tail, and the level of later phrases follows the first within 3 dB, never past a peak of 0.98', () => {
  const joiner = new PhraseJoiner();
  joiner.shape(phrase({level: 0.3}), {text: 'One.', first: true});
  const quieter = joiner.shape(phrase({level: 0.25}), {text: 'Two.'});
  const level = measureSpeech(quieter).level;
  assert.ok(Math.abs(level - 0.3 / Math.SQRT2) < 0.01, `matched ${level}`);
  const muchQuieter = joiner.shape(phrase({level: 0.05}), {text: 'Three.'});
  assert.ok(Math.abs(measureSpeech(muchQuieter).level / (0.05 / Math.SQRT2) - 10 ** (3 / 20)) < 0.02, 'no more than +3 dB');
  const loud = new PhraseJoiner();
  loud.shape(phrase({level: 0.1}), {text: 'One.', first: true});
  const hot = loud.shape(phrase({level: 0.9}), {text: 'Two.'});
  assert.ok(measureSpeech(hot).peak <= 0.9 + 1e-6, 'a louder phrase is turned down, never up');
  const last = new PhraseJoiner().shape(phrase({tail: 400}), {text: 'End.', first: true, last: true});
  assert.equal(last.length - measureSpeech(last).end, ms(LAST_TAIL_KEEP_MS));
});

test('a phrase that cannot be measured is passed on whole, and the shaping is fast', () => {
  const joiner = new PhraseJoiner();
  const quiet = new Float32Array(24000);
  assert.equal(joiner.shape(quiet, {text: 'x', first: true}).length, 24000);
  const long = phrase({lead: 900, speech: 12000, tail: 300});
  const began = performance.now();
  for (let n = 0; n < 20; n++) new PhraseJoiner().shape(long, {text: 'A long one.', first: true});
  assert.ok((performance.now() - began) / 20 < 20, 'twelve seconds of speech shaped in well under 20 ms');
});
