import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stripPlayerEcho, speakerTurn, cleanReply} from './mistral-prompt.mjs';

// Live 2026-10-16, Delamain's cab: V typed "thanks del" and "really"; the cab's reply began with V's own words ("Thanks, Del. A short drive ...",
// "Really? Then it is settled. ..."), so V's line was spoken again, in Delamain's voice, in front of his answer. The bridge never produces V's
// voice for an add-on speaker (docs/V_VOICE.md): the words were in the model's reply, and they were also kept in its history, which taught it to do it again.

test('a reply that opens with V\'s own line loses those words and keeps the answer', () => {
  const reply = 'Thanks, Del. A short drive is still a drive, and I’ll make it smooth. Nine hundred metres is nothing to me.';
  assert.equal(stripPlayerEcho(reply, 'thanks del'), 'A short drive is still a drive, and I’ll make it smooth. Nine hundred metres is nothing to me.');
  assert.equal(stripPlayerEcho('"Thanks Del!" A short drive.', 'Thanks, Del'), 'A short drive.', 'case, punctuation and quotation marks do not matter');
  assert.equal(stripPlayerEcho('Where are we? We are in Watson, V.', 'Where are we'), 'We are in Watson, V.');
});

test('only a real echo is cut: a different opening, an echo that is the whole reply, and a one word answer stay', () => {
  assert.equal(stripPlayerEcho('Thanks, Bob. Fine.', 'thanks del'), 'Thanks, Bob. Fine.');
  assert.equal(stripPlayerEcho('Thanks, Del.', 'thanks del'), 'Thanks, Del.', 'nothing would be left');
  assert.equal(stripPlayerEcho('Thanks. A short drive.', 'thanks del'), 'Thanks. A short drive.', 'the reply only starts like V\'s line');
  assert.equal(stripPlayerEcho('Yes. The route is optimal.', 'yes'), 'Yes. The route is optimal.', 'a one word line answered with the same word is an answer');
  assert.equal(stripPlayerEcho('Really? Then it is settled. Nine hundred metres is a fine distance.', 'really'), 'Then it is settled. Nine hundred metres is a fine distance.', 'asked back');
  assert.equal(stripPlayerEcho('Fine.', ''), 'Fine.');
  assert.equal(stripPlayerEcho('', 'thanks del'), '');
});

test('while the reply is still being written V\'s words are held back from the voice, then the answer shows', () => {
  const said = 'thanks del';
  assert.equal(stripPlayerEcho('Thanks', said, {streaming: true}), '');
  assert.equal(stripPlayerEcho('Thanks, Del.', said, {streaming: true}), '');
  assert.equal(stripPlayerEcho('Thanks, Del. A short', said, {streaming: true}), 'A short');
  assert.equal(stripPlayerEcho('Thanks, Bob', said, {streaming: true}), 'Thanks, Bob', 'the moment it differs it is shown as it is');
  assert.equal(stripPlayerEcho('A short drive', said, {streaming: true}), 'A short drive');
  const growth = ['Than', 'Thanks, De', 'Thanks, Del. A', 'Thanks, Del. A short drive'].map(text => stripPlayerEcho(text, said, {streaming: true}));
  assert.deepEqual(growth, ['', '', 'A', 'A short drive'], 'a half written word of V\'s line is not V\'s line yet');
});

test('a model that writes the talk as a script keeps only the speaker\'s own lines', () => {
  assert.equal(speakerTurn('V: Thanks, Del. Delamain: A short drive. V: Really?', 'Delamain'), 'A short drive.');
  assert.equal(speakerTurn('V: Thanks, Del.\nDelamain: A short drive.', 'Delamain'), 'A short drive.');
  assert.equal(speakerTurn('Delamain: A short drive. V: Thanks.', 'Delamain'), 'A short drive.');
  assert.equal(speakerTurn('Fine, V. V: Thanks.', 'Delamain'), 'Fine, V.');
  assert.equal(speakerTurn('A short drive, V. Thank you: it is nothing.', 'Delamain'), 'A short drive, V. Thank you: it is nothing.', 'no V label: unchanged');
  assert.equal(speakerTurn('V: Thanks, Del. A short', 'Delamain', {streaming: true}), '', 'V\'s label first and the speaker not reached yet: held back');
  assert.equal(speakerTurn('V: Thanks, Del. A short', 'Delamain'), 'V: Thanks, Del. A short', 'finished text without the speaker\'s label: left to the old cleaning');
  assert.equal(cleanReply('V: Thanks, Del.\nDelamain: A short drive is still a drive.', {name: 'Delamain'}), 'A short drive is still a drive.');
  assert.equal(cleanReply('Delamain: Of course, V.', {name: 'Delamain'}), 'Of course, V.', 'the old label cleaning is unchanged');
  assert.equal(cleanReply('V: hello there', {name: 'Judy'}), 'hello there', 'and so is the old leading V label cleaning');
});
