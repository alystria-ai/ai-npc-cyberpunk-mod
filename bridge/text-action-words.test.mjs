import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {screenWords, mentions} from './text-action-words.mjs';

const phrases = JSON.parse(await readFile(new URL('./fixtures/action-phrases.json', import.meta.url), 'utf8'));

test('every kind of request for an action passes the screen (recall of the screen alone is at least 95%)', () => {
  for (const code of ['DRIVE', 'FIGHT', 'FOLLOW', 'LEAVE']) {
    const mine = phrases.requests.filter(row => row.code === code);
    const missed = mine.filter(row => !screenWords(row.text, {}).includes(code));
    assert.ok(mine.length >= 40);
    assert.ok(missed.length / mine.length <= 0.05, `${code} missed: ${missed.map(row => row.text).join(' | ')}`);
  }
});

test('ordinary talk mostly stops at the screen, and the look-alikes that pass are left to the decision', () => {
  const passed = phrases.chat.filter(text => screenWords(text, {}).length);
  // About a quarter of these are look-alikes ("nice car", "I used to fight"): they pass and the decision says no. Plain talk is stopped.
  assert.ok(passed.length / phrases.chat.length <= 0.3, `${passed.length} of ${phrases.chat.length} pass`);
  for (const text of ['How are you holding up?', 'What do you think of the traffic in this city?', 'Tell me a story.', 'Thanks for the help.', 'Hmm. I am not sure about that.',
    'I had a weird dream last night.', 'Do you like music?', 'Okay.', 'Yes', 'What is your favourite food?']) assert.deepEqual(screenWords(text, {}), [], text);
});

test('only the offered actions count, and a request for an action that is not offered passes nothing', () => {
  assert.deepEqual(screenWords('drive for me', {codes: ['LEAVE']}), []);
  assert.deepEqual(screenWords('drive for me', {codes: ['DRIVE', 'LEAVE']}), ['DRIVE']);
  assert.deepEqual(screenWords('Attack him and follow me', {codes: ['FIGHT', 'FOLLOW']}), ['FIGHT', 'FOLLOW']);
});

test('a short answer to the character\'s own offer counts for the action it was about', () => {
  const last = {v: 'I am tired.', r: 'You look tired. Want me to drive?'};
  assert.deepEqual(screenWords('yes please', {codes: ['DRIVE', 'LEAVE'], last}), ['DRIVE']);
  assert.deepEqual(screenWords('yes please', {codes: ['DRIVE', 'LEAVE'], last: {r: 'Nice weather.'}}), []);
  assert.deepEqual(screenWords('well, I have been thinking about it for a long time and I still do not know', {codes: ['DRIVE'], last}), [], 'a long line is not a short answer');
});

test('the screen is a few microseconds, never a request', () => {
  const line = 'How are you holding up? I was thinking about the traffic in this city and where the plan goes next';
  const start = performance.now();
  for (let i = 0; i < 2000; i++) screenWords(line, {});
  assert.ok((performance.now() - start) / 2000 < 0.5, 'under half a millisecond a line');
  assert.equal(mentions('DRIVE', 'x'.repeat(100000)), false, 'a huge line is cut before it is scanned');
});
