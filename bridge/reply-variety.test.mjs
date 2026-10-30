import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repeatedOpeners, repeatedPhrases, varietyNote, freshenReply, headRepeats, dedupeHistory, announcesPresence, mentionsClothes, clothesFixation} from './reply-variety.mjs';

// The replies of Panam Palmer in the owner's live talk of 2026-10-31 (Mistral preset, Ministral 8B), shortened.
const LIVE = [
  'Oh, you’re still here, huh? I’m fine, just tired of Mitch’s grumbling and the kids’ antics. You wanna hear about it, or are you just gonna stand there looking all smug?',
  'Well, I’m still here, standing right beside you, and I’d rather hear what’s on your mind than Mitch’s complaints. You’re not gonna chicken out on that bet, are you?',
  'Oh, you still haven’t forgotten that bet, huh? Five hundred eddies, my sweet. You’re gonna lose, but I’ll let you live with the shame.',
  'Oh, you’re still here, huh? Fine. You wanna settle this bet, you’re gonna have to beat my time on that route. But you’re gonna need more than just a suit and a prayer, you’re gonna need to actually drive.',
  'You’re gonna settle that bet, you’re gonna do it right now. I don’t care if you’re tired or if you’re still in that damn suit, you’re gonna drive that route with me, and if you don’t, I’m gonna call you a coward in front of the whole damn camp.',
  'Five hundred eddies, huh? Well, you’re gonna need more than that to buy my silence after you lose. You’re gonna drive that route with me, and if you don’t, I’m gonna call you a coward in front of the whole damn camp. Now, you wanna make good on that bet, or are you just gonna stand there looking all smug?',
];

test('openers: the words two or more of the last replies start with', () => {
  const openers = repeatedOpeners(LIVE.slice(0, 4));
  assert.deepEqual(openers[0], ['oh', 'you’re', 'still', 'here'].map(word => word.replace('’', "'")), 'the opener three replies of four share, in full');
  assert.ok(openers.length <= 3);
  // Nothing repeats: nothing is named, and the note does not claim she repeats herself.
  assert.deepEqual(repeatedOpeners(['Morning, you insomniac. Must be something.', 'Saul is playing hero again, and I am keeping him honest.']), []);
  assert.equal(varietyNote(['Morning, you insomniac. Must be something.', 'Saul is playing hero again, and I am keeping him honest.']), '', 'a short talk with no repeat has no note');
  assert.deepEqual(repeatedOpeners([]), []);
  assert.deepEqual(repeatedOpeners(['hi', 'ok']), [], 'a reply of fewer than three words has no opener');
});

test('phrases: runs of five words or more that two of the last replies share; the longest sentence of the last reply stands in when fewer than two repeat', () => {
  const phrases = repeatedPhrases(LIVE.slice(-3));
  assert.ok(phrases.some(phrase => phrase.includes('drive that route with me')), phrases.join(' | '));
  assert.ok(phrases.length <= 3 && phrases.every(phrase => phrase.split(' ').length <= 12));
  const none = repeatedPhrases(['Mitch fixed the truck last night.', 'Carol keeps the books straight, and she never complains about the long hours we keep.']);
  assert.equal(none.length, 1, 'one stand-in');
  assert.match(none[0], /carol keeps the books straight/);
  assert.deepEqual(repeatedPhrases(['short one', 'short two']), []);
});

test('clothes: two replies of the last six that talk about V\'s clothes are a fixation, unless V asked', () => {
  assert.equal(mentionsClothes('You are still in that damn suit.'), true);
  assert.equal(mentionsClothes('That suitcase is heavy.'), false, 'a word that only starts like one');
  assert.equal(clothesFixation(LIVE), true);
  assert.equal(clothesFixation(LIVE.slice(0, 3)), false);
  const asked = varietyNote(LIVE, {clothesOk: true}), unasked = varietyNote(LIVE);
  assert.doesNotMatch(asked, /clothes/);
  assert.match(unasked, /leave them out unless V asks/);
});

test('the note: one short paragraph, plain words, nothing for a new talk, no dashes or semicolons', () => {
  assert.equal(varietyNote([]), '');
  assert.equal(varietyNote([LIVE[0]]), '', 'one reply has nothing to repeat');
  const note = varietyNote(LIVE);
  assert.match(note, /^Your last replies repeat themselves/);
  assert.match(note, /Do not open with "/);
  assert.match(note, /Do not reuse "/);
  assert.ok(note.length < 460, `${note.length} chars`);
  assert.doesNotMatch(note, /[;–—]|--/);
  // The same replies give the same note: the prompt of a retry matches the first.
  assert.equal(varietyNote(LIVE), note);
});

test('a reply that opens as her last ones did loses the opener; one that says a sentence again with a word changed loses that sentence', () => {
  const fresher = freshenReply('Oh, you’re still here, huh? Mitch will have a fit when he hears about the route and the money.', LIVE);
  assert.deepEqual(fresher, {reply: 'Mitch will have a fit when he hears about the route and the money.', dropped: 1});
  const again = freshenReply('Five hundred eddies, huh? You’re gonna lose, baby, and I’m gonna call you a coward in front of the whole damn camp. Mitch is bringing the truck round at dawn.', LIVE);
  assert.equal(again.reply, 'Mitch is bringing the truck round at dawn.');
  const inserted = freshenReply('You’re gonna lose, baby, again, but I’ll let you live with the shame. Mitch is bringing the truck round at dawn tomorrow.', LIVE);
  assert.equal(inserted.reply, 'Mitch is bringing the truck round at dawn tomorrow.', 'a word added inside the sentence does not hide it');
});

test('freshenReply leaves a new reply alone, and a reply that would have too little left', () => {
  assert.equal(freshenReply('Mitch is bringing the truck round at dawn. Bring coffee, and wear something warm.', LIVE), null);
  assert.equal(freshenReply('Oh, you’re still here, huh? Fine.', LIVE), null, 'the old check asks again for a reply that is only a repeat');
  assert.equal(freshenReply('One sentence only, and it is a new one.', LIVE), null);
  assert.equal(freshenReply('Anything at all, and more words after it.', []), null);
});

test('stock phrases of fewer than two content words are not a repeated line', () => {
  const earlier = ['He said that is what it is, V, and I am not going to argue about it.'];
  assert.equal(freshenReply('Look, that is what it is, so go. Mitch is bringing the truck round at dawn.', earlier), null);
});

test('presence: a short sentence that only says she is here, beside V, or that V is here, is left out in a talk in person', () => {
  for (const sentence of ['Oh, you’re still here, huh?', 'Still here, huh?', 'I’m still here, standing right beside you.', 'You’re back.', 'I’m right here.', 'She is here.', 'You’re here now.', 'Well, you’re still here, aren’t you?', 'I’m right here, baby.', 'Oh, so you’re back, huh?'])
    assert.equal(announcesPresence(sentence), true, sentence);
  for (const sentence of ['I’m here to help you with that.', 'You’re back from the Badlands, huh?', 'I’m here for you.', 'I was standing here waiting for the truck to cool down enough to touch it.', 'Where are you?'])
    assert.equal(announcesPresence(sentence), false, sentence);
  const reply = 'Oh, you’re still here, huh? Mitch will have a fit when he hears about the route and the money.';
  assert.equal(freshenReply(reply, [], {inPerson: true}).reply, 'Mitch will have a fit when he hears about the route and the money.');
  assert.equal(freshenReply(reply, []), null, 'on the phone "I am here" is an answer');
  assert.equal(headRepeats('Still here, huh? Fine.', [], {inPerson: true}), true);
  assert.equal(headRepeats('Still here, huh? Fine.', []), false);
});

test('the voice does not start on a repeated opener or sentence', () => {
  assert.equal(headRepeats('Oh, you’re still here, huh? Fine, then.', LIVE), true);
  assert.equal(headRepeats('Five hundred eddies, huh? Well.', LIVE), true);
  assert.equal(headRepeats('Mitch is bringing the truck round at dawn.', LIVE), false);
  assert.equal(headRepeats('Anything.', []), false);
});

test('the history shown to the model keeps the first opener and drops the later ones; the stored turns are not changed', () => {
  const history = LIVE.map((r, index) => ({v: `line ${index}`, r}));
  const shown = dedupeHistory(history);
  assert.equal(shown.length, history.length);
  assert.equal(shown[0].r, LIVE[0], 'the first stays');
  assert.ok(!/^Oh, you’re still here, huh\?/.test(shown[3].r), shown[3].r);
  assert.ok(shown.every((turn, index) => turn.v === history[index].v));
  assert.equal(history[3].r, LIVE[3], 'the input is not changed');
  assert.deepEqual(dedupeHistory([]), []);
  assert.equal(dedupeHistory([{v: 'a', r: 'only one'}])[0].r, 'only one');
  // In person the announcements go from the first turn on.
  assert.equal(dedupeHistory([{v: 'a', r: 'Still here, huh? Mitch will have a fit when he hears about the route and the money.'}], {inPerson: true})[0].r, 'Mitch will have a fit when he hears about the route and the money.');
});

test('tags and stage directions do not count as words', () => {
  assert.equal(freshenReply('[laugh] Oh, you’re still here, huh? Mitch will have a fit when he hears about the route and the money.', LIVE)?.dropped, 1);
});
