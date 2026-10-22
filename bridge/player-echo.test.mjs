import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stripPlayerEcho, speakerTurn, cleanReply, stripEchoOpener, stripStockTail} from './mistral-prompt.mjs';

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

// ---- startsLikeLine: what the voice must not speak yet because it may be a line already said ----------------------------------------

import {startsLikeLine} from './mistral-prompt.mjs';

test('startsLikeLine holds a reply that so far only repeats the start of a recent line, half-written word included', () => {
  const lines = ['Ah, Arroyo. Where the factories hum and the air tastes of oil.', 'Short one.'];
  assert.equal(startsLikeLine('Ah, Ar', lines), true);
  assert.equal(startsLikeLine('Ah, Arroyo.', lines), true);
  assert.equal(startsLikeLine('Ah, Arroyo. Where the factories hum and the air tastes of oil.', lines), true, 'the whole line');
  assert.equal(startsLikeLine('Ah, Arroyo. Where the factories hum and the air tastes of oil. More.', lines), true, 'the line and more');
  assert.equal(startsLikeLine('Ah, Arroyo. It is', lines), false, 'moved on');
  assert.equal(startsLikeLine('Awful', lines), false);
  assert.equal(startsLikeLine('Short one.', lines), false, 'lines under six words are not tracked');
  assert.equal(startsLikeLine('', lines), false);
});

// Response audit 2026-10-22: about one reply in eight (every provider that goes through the text host) opened with a fragment of V's line handed back
// ("Dex?", "Upper floors?", "Never mind what?"), which rule 4 of the output rules forbids, and the small local model ended about one in eight with a stock question.

test("stripEchoOpener cuts a short first sentence made of V's own words and keeps the answer, tags included", () => {
  assert.equal(stripEchoOpener('Dex? Nah, choom. He is trouble and you know it.', 'What do you actually think of Dex? Can we trust him?'), 'Nah, choom. He is trouble and you know it.');
  assert.equal(stripEchoOpener('{anger}Useless? I checked that engine. Twice.', 'You are useless, you know that? I should have gone alone.'), '{anger}I checked that engine. Twice.');
  assert.equal(stripEchoOpener('Never mind what? Come on, spit it out.', 'Never mind.'), 'Come on, spit it out.', "question words and filler may sit beside V's words");
  assert.equal(stripEchoOpener('Upper floors? You need an appointment. Who are you meeting?', 'Hi. I am here to see someone on the upper floors.'), 'You need an appointment. Who are you meeting?');
});

test('stripEchoOpener leaves greetings answered in kind, answers that only share a word, short replies and long first sentences alone', () => {
  assert.equal(stripEchoOpener('Hey. What is going on?', 'Hey.'), 'Hey. What is going on?');
  assert.equal(stripEchoOpener('Hey yourself. You are out early.', 'Hey.'), 'Hey yourself. You are out early.');
  assert.equal(stripEchoOpener('Yeah, sure. Let us go.', 'Yeah.'), 'Yeah, sure. Let us go.');
  assert.equal(stripEchoOpener('Dex? Nah.', 'What about Dex?'), 'Dex? Nah.', 'less than three words would be left');
  assert.equal(stripEchoOpener('Trust him? I would not. He sells everyone out.', 'Do you trust Dex?'), 'Trust him? I would not. He sells everyone out.', 'the word "him" is not in V line');
  assert.equal(stripEchoOpener('The best thing about this place is the noodles, and you know it.', 'What is the best thing about this place?'), 'The best thing about this place is the noodles, and you know it.', 'six words: an answer, not an echo');
  assert.equal(stripEchoOpener('Dex? Nah, choom.', ''), 'Dex? Nah, choom.');
  assert.equal(stripEchoOpener('', 'hello'), '');
});

test('stripEchoOpener while the reply is still being written holds back only what could still be an echo opener', () => {
  const said = 'what about Dex?';
  for (const part of ['Dex', 'Dex?', 'Dex? Nah, choom', '{anger}De', 'Dex? Na']) assert.equal(stripEchoOpener(part, said, {streaming: true}), '', part);
  assert.equal(stripEchoOpener('Dex? Nah, choom. He is trouble', said, {streaming: true}), 'Nah, choom. He is trouble');
  for (const part of ['Nah, choom', 'Hey yourself', 'He sells everyone out', 'Dex, he is trouble']) assert.equal(stripEchoOpener(part, said, {streaming: true}), part, part);
});

test("stripStockTail drops a generic closing question when words of the reply's own stay", () => {
  assert.equal(stripStockTail('I am fine, the work is the work. What is on your mind?'), 'I am fine, the work is the work.');
  assert.equal(stripStockTail('Rough nights are the specialty. What about you?'), 'Rough nights are the specialty.');
  assert.equal(stripStockTail('Fine, thanks for asking. Anything else?'), 'Fine, thanks for asking.');
  assert.equal(stripStockTail('Fine, thanks. And you? What about you?'), 'Fine, thanks. And you?');
  assert.equal(stripStockTail('What is on your mind?'), 'What is on your mind?', 'a reply that is only the stock line stays');
  assert.equal(stripStockTail('Fine. What is on your mind?'), 'Fine. What is on your mind?', 'less than four words would be left');
  assert.equal(stripStockTail('I am fine, the work is the work. Which road are we taking?'), 'I am fine, the work is the work. Which road are we taking?', 'a specific question stays');
  // Questions that belong to a role stay (the review of 2026-10-22).
  assert.equal(stripStockTail('Kabuki is that way. What brings you out to Kabuki?'), 'Kabuki is that way. What brings you out to Kabuki?');
  assert.equal(stripStockTail('Welcome to the clinic. What brings you to the clinic today?'), 'Welcome to the clinic. What brings you to the clinic today?');
  assert.equal(stripStockTail('Welcome to Arasaka Tower. What brings you here?'), 'Welcome to Arasaka Tower. What brings you here?');
  assert.equal(stripStockTail('That is eleven eddies for the skewers. Anything else?', {service: true}), 'That is eleven eddies for the skewers. Anything else?', "a vendor's or a cab's own question");
  assert.equal(stripStockTail('That is eleven eddies for the skewers. Anything else?'), 'That is eleven eddies for the skewers.', 'from anyone else it is the stock line');
});

// The review of 2026-10-22: the first cut also removed answers that repeat V's words. Only V's words asked back are an echo.
test("stripEchoOpener keeps every answer that restates V's words as a statement", () => {
  const kept = [
    ['Should I go with Rogue or Dex?', 'Rogue. She is the queen of fixers, trust me.'],
    ['Militech or Arasaka, which is worse?', 'Arasaka. They own half the city already.'],
    ['Left or right?', 'Left. Then straight on to the bridge.'],
    ["You hate me, don't you?", "I don't hate you. I am just tired, V."],
    ['I love you.', 'I love you. More than I can say.'],
    ['Can you help me or not?', 'I can help. But it will cost you.'],
    ['Are you coming with me or not?', 'I am coming. Just give me a sec.'],
    ['Is the car fixed?', 'Fixed. Took me all night though.'],
    ['Tell me about Jackie.', 'Jackie... he was my brother, V. Always will be.'],
    ['Wake up, Samurai.', 'Samurai. Now there is a name I have not heard in years.'],
    ['¿Arasaka o Militech?', 'Arasaka. Sin duda, son los peores.'],
  ];
  for (const [said, reply] of kept) {
    assert.equal(stripEchoOpener(reply, said), reply, reply);
    assert.equal(stripEchoOpener(reply, said, {streaming: true}), reply, 'streaming: nothing is cut once the sentence has ended');
  }
  // A streamed reply whose first sentence has ended with a full stop is released at once, whole.
  assert.equal(stripEchoOpener('Rogue. She is the queen of fixers, trust me.', 'Should I go with Rogue or Dex?', {streaming: true}), 'Rogue. She is the queen of fixers, trust me.');
});

test('stripEchoOpener still cuts the echoes asked back as a question, and starts what remains with a capital', () => {
  assert.equal(stripEchoOpener('Dex? nah, choom. He is trouble and you know it.', 'What do you think of Dex?'), 'Nah, choom. He is trouble and you know it.');
  assert.equal(stripEchoOpener('¿Dex? No me fío de él. Es un problema.', 'Qué piensas de Dex?'), 'No me fío de él. Es un problema.');
  assert.equal(stripEchoOpener('Von Dex? Der ist ein Problem, glaub mir.', 'Was denkst du von Dex?'), 'Der ist ein Problem, glaub mir.');
  assert.equal(stripEchoOpener('Dex? Nah, choom. He is trouble.', 'What about Dex?', {streaming: true}), 'Nah, choom. He is trouble.');
});

test('stripEchoOpener: "?!" and "!?" are questions, and the other menu languages\' question words sit beside V\'s words', () => {
  assert.equal(stripEchoOpener('Dex?! That snake? He sold us out, V.', 'What about Dex?'), 'That snake? He sold us out, V.');
  assert.equal(stripEchoOpener('Dex!? Der ist ein Problem, glaub mir.', 'Was denkst du von Dex?'), 'Der ist ein Problem, glaub mir.');
  assert.equal(stripEchoOpener('Was, Dex? Er hat uns alle verkauft.', 'Was denkst du von Dex?'), 'Er hat uns alle verkauft.');
});

test('stripStockTail also drops the stock questions that end with ", V", and keeps a role question', () => {
  assert.equal(stripStockTail('I am fine, the work is the work. What about you, V?'), 'I am fine, the work is the work.');
  assert.equal(stripStockTail('Fine, thanks for asking. Anything else, V?'), 'Fine, thanks for asking.');
  assert.equal(stripStockTail('Eleven eddies for the skewers, hot off the grill. Anything else, V?', {service: true}), 'Eleven eddies for the skewers, hot off the grill. Anything else, V?');
});
