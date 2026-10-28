import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {matchChoice, namedPosition, normalize, captionText, tokens} from './voice-choice-match.mjs';

// Speak dialogue choices (docs/VOICE_CHOICES.md): which caption did the player say? The matcher is pure and has no model, so the accuracy below is the
// accuracy of the product. The cases (bridge/voice-choice-cases.json) are hubs written in the style of the game's choice lists, each with what a
// recogniser would write for: the caption read out, a paraphrase, one telling word, a position, a near miss (same words, other meaning, or two options
// equally close) and chatter. A wrong pick is much worse than none, so the test pins ZERO wrong picks and ZERO picks on near misses and chatter, and lower
// bounds for what must be picked. Paraphrases that need an understanding of meaning ("what does this cost" for "How much do you charge?") are not picked
// on purpose: the player gets one short notice and says it again with other words or its number.
const data = JSON.parse(readFileSync(new URL('./voice-choice-cases.json', import.meta.url), 'utf8'));

function evaluate() {
  const kinds = {};
  const wrong = [], falsePicks = [];
  for (const hub of data.hubs) {
    for (const item of hub.cases) {
      const verdict = matchChoice(item.say, hub.captions);
      const picked = verdict.status === 'pick' ? verdict.index : null;
      const row = kinds[item.kind] ??= {n: 0, picked: 0};
      if (item.expect !== null) row.n++;
      else row.silent = (row.silent ?? 0) + 1;
      if (picked === null) continue;
      if (item.expect === null) falsePicks.push([hub.id, item.say, hub.captions[picked]]);
      else if (picked !== item.expect) wrong.push([hub.id, item.say, hub.captions[picked], hub.captions[item.expect]]);
      else row.picked++;
    }
  }
  return {kinds, wrong, falsePicks};
}

test('the case set is the size it was written for, in six languages', () => {
  const cases = data.hubs.reduce((sum, hub) => sum + hub.cases.length, 0);
  assert.ok(data.hubs.length >= 50 && cases >= 600, `${data.hubs.length} hubs, ${cases} cases`);
  assert.deepEqual([...new Set(data.hubs.map(hub => hub.language))].sort(), ['de', 'en', 'es', 'fr', 'pl', 'ru']);
  for (const hub of data.hubs) assert.equal(new Set(hub.captions).size, hub.captions.length, hub.id + ' has a repeated caption');
});

test('never a wrong pick, never a pick on a near miss or on chatter', () => {
  const {wrong, falsePicks} = evaluate();
  assert.deepEqual(wrong, [], 'a spoken line picked another option than the one meant');
  assert.deepEqual(falsePicks, [], 'a line that should pick nothing picked an option');
});

test('what must be picked is picked: captions read out, positions, telling words', () => {
  const {kinds} = evaluate();
  const rate = kind => kinds[kind].picked / kinds[kind].n;
  assert.equal(rate('exact'), 1, 'a caption read out loud');
  assert.ok(rate('number') >= 0.98, 'a position: ' + rate('number'));
  assert.ok(rate('keyword') >= 0.9, 'one telling word: ' + rate('keyword'));
  // Wording that only means the same is mostly left alone (no model decides what a sentence means); the part that overlaps the words is picked.
  assert.ok(rate('paraphrase') >= 0.1, 'paraphrase: ' + rate('paraphrase'));
  assert.equal(kinds['near-miss'].picked + kinds.unrelated.picked, 0);
});

test('normalising: case, accents, quotes, brackets and markup', () => {
  assert.equal(normalize('  Où est “Jackie”, là-bas ? '), 'ou est jackie la bas');
  assert.equal(normalize("Who's there?"), 'who there');
  assert.equal(captionText('[Persuade] You can do better than that.'), 'You can do better than that.');
  assert.equal(captionText('[Leave]'), 'Leave');
  assert.equal(captionText('<i>Say nothing.</i>'), 'Say nothing.');
  assert.deepEqual(tokens("l'option deux"), ['l', 'option', 'deux']);
  assert.deepEqual(tokens('日本語のテスト').length > 3, true, 'unspaced scripts become character pairs');
});

test('positions: ordinals, numbers, last, middle, and the homophones a recogniser writes', () => {
  assert.deepEqual(namedPosition('option two', 4), {index: 1, kind: 'number'});
  assert.deepEqual(namedPosition('the third one', 4), {index: 2, kind: 'number'});
  assert.deepEqual(namedPosition('number 3 please', 4), {index: 2, kind: 'number'});
  assert.deepEqual(namedPosition('the last one', 4), {index: 3, kind: 'last'});
  assert.deepEqual(namedPosition('the middle one', 3), {index: 1, kind: 'middle'});
  assert.deepEqual(namedPosition('the middle one', 4), {out: true, value: 0});
  assert.deepEqual(namedPosition('one', 3), {index: 0, kind: 'number'});
  assert.deepEqual(namedPosition('option to', 3), {index: 1, kind: 'number'}, '"to" after a command word is two');
  assert.deepEqual(namedPosition('number for', 4), {index: 3, kind: 'number'});
  assert.equal(namedPosition('to', 3), null, 'a lone "to" is not a number');
  assert.equal(namedPosition('for', 3), null);
  assert.deepEqual(namedPosition('option five', 3), {out: true, value: 5});
  assert.equal(namedPosition('two cups of coffee please', 3), null, 'a number inside a sentence is a sentence');
  assert.equal(namedPosition('option two three', 4), null, 'two positions are no position');
  assert.deepEqual(namedPosition('la tercera', 4), {index: 2, kind: 'number'});
  assert.deepEqual(namedPosition('zweite Option', 3), {index: 1, kind: 'number'});
  assert.deepEqual(namedPosition('второй вариант', 3), {index: 1, kind: 'number'});
  assert.deepEqual(namedPosition('opcja trzecia', 4), {index: 2, kind: 'number'});
});

test('a caption that is literally the word beats the position ("Two." / "One more thing.")', () => {
  assert.deepEqual(matchChoice('two', ['One.', 'Two.', 'Three.']), {status: 'pick', index: 1, score: 1, runnerUp: 0, reason: 'exact'});
  assert.equal(matchChoice('option two', ['One.', 'Two.', 'Three.']).index, 1);
  assert.equal(matchChoice('the second one', ['I agree.', 'One more thing.', 'Never mind.']).index, 1);
});

test('the words: all of a caption, a part of it, a telling word, a near spelling', () => {
  const hub = ['Where is Jackie?', 'Let us grab a drink.', 'Do you think he is still alive?'];
  assert.equal(matchChoice('where is jackie', hub).index, 0);
  assert.equal(matchChoice('jackie', hub).index, 0);
  assert.equal(matchChoice('grab a drink', hub).index, 1);
  assert.equal(matchChoice('is he still alive', hub).index, 2);
  assert.equal(matchChoice('were is jackie', hub).index, 0, 'a recogniser slip is read');
});

test('refusals: two options fit, nothing fits, a flipped meaning, a question for a statement', () => {
  const yes = ["Yes, I'll do it.", 'Yes, but I want more money.', 'No.'];
  assert.equal(matchChoice('yes', yes).status, 'ambiguous');
  assert.equal(matchChoice('yes but more money', yes).index, 1);
  assert.equal(matchChoice('no', yes).index, 2);
  assert.equal(matchChoice('hello there general kenobi', yes).status, 'none');
  assert.equal(matchChoice('', yes).status, 'none');
  assert.equal(matchChoice('uh', yes).status, 'none');
  assert.equal(matchChoice("I'm not bleeding", ["Please help, I'm bleeding.", 'Tell them I am fine.']).status, 'none');
  assert.notEqual(matchChoice('what is the job', ["Maybe next time.", "Let's do the job now.", 'Never mind.']).status, 'pick');
  assert.equal(matchChoice('option five', yes).status, 'ambiguous');
  assert.equal(matchChoice('option five', yes).reason, 'out-of-range');
});

test('the list: a greyed-out line (empty caption) is never picked, nor the line a lone "the" matches', () => {
  assert.equal(matchChoice('option two', ['Talk.', '', 'Leave.']).status, 'none');
  assert.equal(matchChoice('leave', ['Talk.', '', 'Leave.']).index, 2);
  assert.equal(matchChoice('the', ['Talk to the boss.', 'Leave.']).status, 'none');
  assert.equal(matchChoice('anything', []).status, 'none');
  assert.equal(matchChoice('anything', undefined).status, 'none');
});

test('a hub of one caption still needs the player to say something that fits it', () => {
  assert.equal(matchChoice('continue', ['[Continue]']).index, 0);
  assert.equal(matchChoice('banana', ['[Continue]']).status, 'none');
});

test('it is quick: a thousand matches on a six-line list take well under a second', () => {
  const hub = ['Tell me about the job you mentioned earlier.', 'What is in it for me?', "I'll think about it.", 'Never mind.', 'Where is Jackie?', 'Let us go.'];
  const started = performance.now();
  for (let i = 0; i < 1000; i++) matchChoice('tell me about the job', hub);
  const per = (performance.now() - started) / 1000;
  assert.ok(per < 1, `${per.toFixed(3)} ms each`);
});
