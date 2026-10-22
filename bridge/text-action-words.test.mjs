import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {screenWords, mentions, certainWords} from './text-action-words.mjs';

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

test('slang, typos and the other languages of the menus pass the screen (a dropped ask is a silent miss), and plain talk still stops there', () => {
  const asks = {
    DRIVE: ['run me to the club', 'carry me to Kabuki', 'hit the road, you steer', 'steer for me', 'whip us over to the Afterlife', 'Poprowadź', 'Fahr du, ich bin müde', 'Llévame al marcador, por favor'],
    FIGHT: ['smoke that guy', 'bust him up', 'whack him', 'finish the job', 'take care of the tagged guy', 'go hurt him', 'blow his head off', 'jump him', 'clean him up', 'Mach ihn fertig', 'Occupati di lui', 'Zlikwiduj go'],
    FOLLOW: ['come', 'cmon', 'folow me', 'follw me', 'fllow me pls', 'come w me', 'Chodź ze mną', 'Пойдём со мной'],
    LEAVE: ['not needed anymore', 'take a hike', 'I got it from here', 'you are off the hook', 'Możesz iść', 'Ты свободен', 'Puedes irte'],
  };
  for (const [code, lines] of Object.entries(asks)) for (const line of lines) assert.ok(screenWords(line, {codes: [code]}).includes(code), `${code}: ${line}`);
  // The wider stems keep ordinary talk out: a bare "take care", "hurt", "blow" or "clean" is not a request.
  for (const text of ['Take care of yourself.', 'That really hurt.', 'The wind will blow tonight.', 'I need to clean the kitchen.', 'Whatever you say.', 'I love this song']) assert.deepEqual(screenWords(text, {}), [], text);
});

test('the screen is a few microseconds, never a request', () => {
  const line = 'How are you holding up? I was thinking about the traffic in this city and where the plan goes next';
  const start = performance.now();
  for (let i = 0; i < 2000; i++) screenWords(line, {});
  assert.ok((performance.now() - start) / 2000 < 0.5, 'under half a millisecond a line');
  assert.equal(mentions('DRIVE', 'x'.repeat(100000)), false, 'a huge line is cut before it is scanned');
});

test('certainWords: only a bare command or a question about the character settles a line; everything else, other languages and leaves included, is the model\'s', () => {
  const codes = ['DRIVE', 'FIGHT', 'FOLLOW', 'LEAVE'];
  for (const [line, code] of [['drive me', 'DRIVE'], ['Judy, drive me.', 'DRIVE'], ['hey, take the wheel!', 'DRIVE'], ['please follow me', 'FOLLOW'], ['Come with me.', 'FOLLOW'], ['attack him', 'FIGHT'], ['Take them out', 'FIGHT']])
    assert.deepEqual(certainWords(line, {codes}), {code, argument: ''}, line);
  for (const line of ['do you know how to drive?', 'did you ever fight in the pits?', 'Have you ever followed anyone home?'])
    assert.deepEqual(certainWords(line, {codes}), {none: true}, line);
  for (const line of ["Why don't you drive?", 'How about you take the wheel?', 'Are you coming with me?', 'Why not follow me?', 'Can you drive me?', 'could you follow me', "I'm gonna need a ride to the marker.",
    'drive me to the waypoint', 'drive me. now.', 'Follow me. Do you know the way?', 'do you know how to drive me there?', 'do you know how to drive', "Why don't you go home?", 'I work alone.', 'I think I am better off solo.',
    'My job here is done.', 'I chod\u017a za mn\u0105', 'I chodz za mna', 'Fahr mich', '\u0432\u0435\u0434\u0438 \u043c\u0435\u043d\u044f', '', 'x'.repeat(200)])
    assert.equal(certainWords(line, {codes}), null, line);
  assert.equal(certainWords('drive me', {codes: ['FIGHT']}), null, 'an action the game did not offer');
  assert.equal(certainWords('drive me', {codes, found: ['DRIVE', 'LEAVE']}), null, 'a leave among the words always goes to the model');
  assert.equal(certainWords('go home', {codes}), null);
});
